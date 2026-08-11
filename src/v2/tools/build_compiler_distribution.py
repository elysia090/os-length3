#!/usr/bin/env python3
"""Build a standalone, content-addressed compiler distribution.

The inputs may come from an installed toolchain package, but the output has no
runtime package dependency:

    compiler.wasm
    compiler.pages
    compiler-regions.pages
    compiler-steps.pages
    compiler-resources.tar
    compiler-resources.pages
    compiler.json
"""

import argparse
from io import BytesIO
import hashlib
import json
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qm.wasmbinary import function_exports, index_module, optimize_module
from qm.pagearchive import pack_wasm_steps, unpack as unpack_pages
from qm.wasmregions import pack as pack_regions
from kernel.pagefabric import (bundle_prefix_size, dump_bundle, dump_manifest,
                               project)


DELIVERY_PAGE_BYTES = 1 << 16
DELIVERY_DATA_SHARDS = 8
DELIVERY_PARITY_SHARDS = 2


def resource_index(payload):
    """Return the canonical file cut for a tar without retaining the tar.

    The browser only needs names, types and exact payload coordinates while
    the compiler is cold.  File bytes remain in the physical-page bundle and
    are admitted after a WASI read faults on that path.  Adjacent names are
    prefix coded because LLVM resource archives contain thousands of siblings.
    """
    try:
        archive = tarfile.open(fileobj=BytesIO(payload), mode='r:*')
    except tarfile.TarError:
        return {'format': 'tar-cut-v1', 'mount': '/usr', 'entries': []}

    records = []
    with archive:
        for member in archive.getmembers():
            raw = member.name.replace('\\', '/').strip('/')
            parts = [part for part in raw.split('/') if part not in ('', '.')]
            if not parts or any(part == '..' for part in parts):
                continue
            name = '/'.join(parts)
            if member.isfile():
                records.append((name, 'f', int(member.offset_data),
                                int(member.size)))
            elif member.isdir():
                records.append((name, 'd'))
            elif member.issym():
                records.append((name, 'l', member.linkname))
    records.sort(key=lambda item: item[0])

    entries = []
    previous = ''
    for record in records:
        name = record[0]
        shared = 0
        if name.isascii() and previous.isascii():
            limit = min(len(name), len(previous))
            while shared < limit and name[shared] == previous[shared]:
                shared += 1
        entries.append([shared, name[shared:], *record[1:]])
        previous = name
    return {'format': 'tar-cut-v1', 'mount': '/usr', 'entries': entries}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def delivery(payload, output, page_bytes=DELIVERY_PAGE_BYTES):
    """Write the disposable direct-page projection for one canonical object."""
    manifest, store = project(
        payload, page_size=page_bytes,
        data_shards=DELIVERY_DATA_SHARDS,
        parity_shards=DELIVERY_PARITY_SHARDS)
    wire = dump_bundle(manifest, store, 'data')
    output.write_bytes(wire)
    prefix_bytes = bundle_prefix_size(wire)
    return {
        'file': output.name,
        'bytes': len(wire),
        'sha256': digest(output),
        'prefix_bytes': prefix_bytes,
        'prefix_sha256': hashlib.sha256(
            wire[:prefix_bytes]).hexdigest(),
        'page_bytes': manifest.page_size,
        'logical_pages': manifest.page_count,
        'unique_pages': manifest.rank_count,
        'manifest_bytes': len(dump_manifest(manifest)),
        'data_shards': manifest.data_shards,
        'parity_shards': manifest.parity_shards,
        'included_shards': 'data',
    }


def build(core, resources, output, version, max_body=4096,
          include_canonical=True):
    core = Path(core)
    resources = Path(resources)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)

    source_payload = core.read_bytes()
    source_hash = hashlib.sha256(source_payload).hexdigest()
    optimized, report = optimize_module(source_payload, max_body=max_body)
    module_index = index_module(optimized)
    exported = dict(function_exports(optimized))
    start_index = exported.get('_start')
    start_body = next((body for body in module_index.bodies
                       if body.function_index == start_index), None)
    compiler = output / 'compiler.wasm'
    if include_canonical:
        compiler.write_bytes(optimized)
    compiler_delivery = delivery(
        optimized, output / 'compiler.pages')
    region_payload = pack_regions(module_index)
    region_delivery = delivery(
        region_payload, output / 'compiler-regions.pages', page_bytes=4096)
    step_payload = pack_wasm_steps(module_index, max_body=max_body)
    step_archive = unpack_pages(step_payload)
    step_delivery = delivery(
        step_payload, output / 'compiler-steps.pages', page_bytes=4096)

    resource_output = output / 'compiler-resources.tar'
    resource_payload = resources.read_bytes()
    if include_canonical:
        resource_output.write_bytes(resource_payload)
    resource_delivery = delivery(
        resource_payload, output / 'compiler-resources.pages')

    public_report = {key: value for key, value in report.items()
                     if key != 'replacements'}
    public_report['replacements'] = [
        {
            'function_index': item.body.function_index,
            'body_bytes': [item.original_size, len(item.raw)],
            'wasm_ops': [item.original_work, item.replacement_work],
        }
        for item in report['replacements']
    ]
    manifest = {
        'schema': 1,
        'version': version,
        'compiler': {
            'file': compiler.name,
            'bytes': len(optimized),
            'sha256': hashlib.sha256(optimized).hexdigest(),
            'source_sha256': source_hash,
            'delivery': compiler_delivery,
            'regions': {
                'bytes': len(region_payload),
                'sha256': hashlib.sha256(region_payload).hexdigest(),
                'delivery': region_delivery,
            },
            'steps': {
                'bytes': len(step_payload),
                'sha256': hashlib.sha256(step_payload).hexdigest(),
                'pages': len(step_archive.entries),
                'directory_bytes': step_archive.directory_bytes,
                'delivery': step_delivery,
            },
            'entry': ({
                'export': '_start',
                'function_index': start_body.function_index,
                'body_ordinal': start_body.ordinal,
                'body_start': start_body.start,
                'body_end': start_body.end,
                'type_index': start_body.type_index,
            } if start_body is not None else None),
        },
        'resources': {
            'file': resource_output.name,
            'bytes': len(resource_payload),
            'sha256': hashlib.sha256(resource_payload).hexdigest(),
            'delivery': resource_delivery,
            'index': resource_index(resource_payload),
        },
        'normalization': public_report,
    }
    manifest_path = output / 'compiler.json'
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True)
                             + '\n', encoding='utf-8', newline='\n')
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('core')
    parser.add_argument('resources')
    parser.add_argument('--out', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--max-body', type=int, default=4096)
    parser.add_argument('--delivery-only', action='store_true',
                        help='omit canonical files reconstructed by the browser')
    parser.add_argument('--json', action='store_true',
                        help='print the complete manifest instead of a summary')
    args = parser.parse_args(argv)
    manifest = build(args.core, args.resources, args.out, args.version,
                     max_body=args.max_body,
                     include_canonical=not args.delivery_only)
    if args.json:
        print(json.dumps(manifest, indent=2, sort_keys=True))
    else:
        compiler = manifest['compiler']
        steps = compiler['steps']
        resources = manifest['resources']
        print('compiler: %d canonical bytes -> %d delivery bytes'
              % (compiler['bytes'], compiler['delivery']['bytes']))
        print('steps: %d functions, %d canonical bytes -> %d delivery bytes'
              % (steps['pages'], steps['bytes'],
                 steps['delivery']['bytes']))
        print('resources: %d canonical bytes -> %d delivery bytes'
              % (resources['bytes'], resources['delivery']['bytes']))
        print('wrote %s' % (Path(args.out) / 'compiler.json'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
