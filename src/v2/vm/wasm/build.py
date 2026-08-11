#!/usr/bin/env python3
"""Compile `vm.c` to a freestanding wasm32 module.

    python3 vm/wasm/build.py [--out path] [--check]

The module is built, not committed: a checked-in binary is a claim nobody can
read, and the C is 300 lines that any clang can turn into the same thing. The
test suite builds it into a temporary directory for the same reason.

`--check` only verifies that it compiles warning-free, which is what a CI step
wants.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, 'vm.c')
ROOT = os.path.dirname(os.path.dirname(HERE))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# -O2 for the same reason the browser compiles the paste at -O2: this is the
# execution substrate a search runs on, and its constant factor is the search's
# constant factor.  32 MB of linear memory holds the table, the undo log and
# the artifact buffer with room to spare.
FLAGS = [
    '--target=wasm32', '-O2', '-ffreestanding', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--export-dynamic',
    '-Wl,--initial-memory=33554432',
    '-Wall', '-Wextra',
]

DELIVERY_PAGE_BYTES = 1 << 16
DELIVERY_DATA_SHARDS = 8
DELIVERY_PARITY_SHARDS = 2


def build(out_path, binary='clang'):
    compiler = binary
    probe = subprocess.run([binary, '-print-prog-name=clang'],
                           capture_output=True, text=True)
    resolved = probe.stdout.strip() if probe.returncode == 0 else ''
    if os.path.isabs(resolved) and os.path.isfile(resolved):
        # Nix's native cc-wrapper injects host linker flags even when clang is
        # explicitly targeting wasm32.  Clang names its unwrapped executable
        # through this standard query, so use that compiler for cross-targets.
        compiler = resolved
    flags = list(FLAGS)
    linker = shutil.which('wasm-ld')
    if compiler != binary and linker is None:
        candidates = glob.glob('/nix/store/*-lld-*/bin/wasm-ld')
        version = re.search(r'clang-(\d+)', compiler)
        if version is not None:
            same = [path for path in candidates
                    if '-lld-%s.' % version.group(1) in path
                    or '-lld-%s-' % version.group(1) in path]
            candidates = same or candidates
        linker = sorted(candidates)[-1] if candidates else None
    if compiler != binary and linker:
        flags.append('-fuse-ld=' + linker)
    result = subprocess.run([compiler] + flags + [SOURCE, '-o', out_path],
                            capture_output=True, text=True)
    return result


def normalize(out_path):
    """Put the compiled VM through the same safe wasm-body QM as drivers."""
    from qm.wasmbinary import optimize_module

    with open(out_path, 'rb') as handle:
        raw = handle.read()
    optimized, report = optimize_module(raw)
    if optimized != raw:
        with open(out_path, 'wb') as handle:
            handle.write(optimized)
    return report


def write_distribution(out_path, report):
    """Write the same authenticated physical-page delivery used by LLVM."""
    from kernel.pagefabric import bundle_prefix_size, dump_bundle, project
    from qm.pagearchive import pack_wasm_steps, unpack as unpack_pages
    from qm.wasmbinary import function_exports, index_module
    from qm.wasmregions import pack as pack_regions

    with open(out_path, 'rb') as handle:
        payload = handle.read()
    indexed = index_module(payload)
    by_function = dict((body.function_index, body)
                       for body in indexed.bodies)
    exports = {}
    for name, function_index in function_exports(payload):
        body = by_function.get(function_index)
        if body is not None:
            exports[name] = {
                'function_index': body.function_index,
                'body_ordinal': body.ordinal,
                'body_start': body.start,
                'body_end': body.end,
                'type_index': body.type_index,
            }
    manifest, store = project(
        payload, page_size=DELIVERY_PAGE_BYTES,
        data_shards=DELIVERY_DATA_SHARDS,
        parity_shards=DELIVERY_PARITY_SHARDS)
    wire = dump_bundle(manifest, store, 'data')
    base, _extension = os.path.splitext(out_path)
    pages_path = base + '.pages'
    regions_path = base + '-regions.pages'
    manifest_path = base + '.json'
    with open(pages_path, 'wb') as handle:
        handle.write(wire)
    prefix_bytes = bundle_prefix_size(wire)
    region_payload = pack_regions(indexed)
    region_manifest, region_store = project(
        region_payload, page_size=4096,
        data_shards=DELIVERY_DATA_SHARDS,
        parity_shards=DELIVERY_PARITY_SHARDS)
    region_wire = dump_bundle(region_manifest, region_store, 'data')
    with open(regions_path, 'wb') as handle:
        handle.write(region_wire)
    region_prefix = bundle_prefix_size(region_wire)
    step_payload = pack_wasm_steps(indexed)
    step_archive = unpack_pages(step_payload)
    step_manifest, step_store = project(
        step_payload, page_size=4096,
        data_shards=DELIVERY_DATA_SHARDS,
        parity_shards=DELIVERY_PARITY_SHARDS)
    step_wire = dump_bundle(step_manifest, step_store, 'data')
    steps_path = base + '-steps.pages'
    with open(steps_path, 'wb') as handle:
        handle.write(step_wire)
    step_prefix = bundle_prefix_size(step_wire)
    metadata = {
        'schema': 1,
        'vm': {
            'file': os.path.basename(out_path),
            'bytes': len(payload),
            'sha256': hashlib.sha256(payload).hexdigest(),
            'exports': exports,
            'regions': {
                'bytes': len(region_payload),
                'sha256': hashlib.sha256(region_payload).hexdigest(),
                'delivery': {
                    'file': os.path.basename(regions_path),
                    'bytes': len(region_wire),
                    'sha256': hashlib.sha256(region_wire).hexdigest(),
                    'prefix_bytes': region_prefix,
                    'prefix_sha256': hashlib.sha256(
                        region_wire[:region_prefix]).hexdigest(),
                    'page_bytes': region_manifest.page_size,
                    'logical_pages': region_manifest.page_count,
                    'unique_pages': region_manifest.rank_count,
                    'data_shards': region_manifest.data_shards,
                    'parity_shards': region_manifest.parity_shards,
                    'included_shards': 'data',
                },
            },
            'steps': {
                'bytes': len(step_payload),
                'sha256': hashlib.sha256(step_payload).hexdigest(),
                'pages': len(step_archive.entries),
                'directory_bytes': step_archive.directory_bytes,
                'delivery': {
                    'file': os.path.basename(steps_path),
                    'bytes': len(step_wire),
                    'sha256': hashlib.sha256(step_wire).hexdigest(),
                    'prefix_bytes': step_prefix,
                    'prefix_sha256': hashlib.sha256(
                        step_wire[:step_prefix]).hexdigest(),
                    'page_bytes': step_manifest.page_size,
                    'logical_pages': step_manifest.page_count,
                    'unique_pages': step_manifest.rank_count,
                    'data_shards': step_manifest.data_shards,
                    'parity_shards': step_manifest.parity_shards,
                    'included_shards': 'data',
                },
            },
            'delivery': {
                'file': os.path.basename(pages_path),
                'bytes': len(wire),
                'sha256': hashlib.sha256(wire).hexdigest(),
                'prefix_bytes': prefix_bytes,
                'prefix_sha256': hashlib.sha256(
                    wire[:prefix_bytes]).hexdigest(),
                'page_bytes': manifest.page_size,
                'logical_pages': manifest.page_count,
                'unique_pages': manifest.rank_count,
                'data_shards': manifest.data_shards,
                'parity_shards': manifest.parity_shards,
                'included_shards': 'data',
            },
        },
        'normalization': {
            'pure_bodies': report['decoded_pure_integer_expressions'],
            'state_bodies': report['decoded_state_integer_expressions'],
            'replaced': report['replaced'],
            'forwarded_memory_loads': report['forwarded_memory_loads'],
            'grammar_misses': report.get('grammar_misses', {}),
        },
    }
    with open(manifest_path, 'w', newline='\n') as handle:
        json.dump(metadata, handle, indent=2, sort_keys=True)
        handle.write('\n')
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default=os.path.join(HERE, 'vm.wasm'))
    parser.add_argument('--check', action='store_true',
                        help='compile to a scratch file and discard it')
    args = parser.parse_args()

    binary = shutil.which('clang')
    if not binary:
        print('no clang on PATH', file=sys.stderr)
        return 2

    out = args.out
    if args.check:
        out = os.path.join(HERE, '.check.wasm')

    result = build(out, binary)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return 1
    # A warning here is a defect: this module has no libc to blame.
    if result.stderr.strip():
        sys.stderr.write(result.stderr)
        return 1

    report = normalize(out)

    size = os.path.getsize(out)
    if args.check:
        os.unlink(out)
        print('vm.c compiles clean (%d bytes)' % size)
    else:
        distribution = write_distribution(out, report)
        print('wrote %s (%d bytes)' % (out, size))
        print('wrote %s (%d bytes, %d-byte authenticated prefix)'
              % (os.path.splitext(out)[0] + '.pages',
                 distribution['vm']['delivery']['bytes'],
                 distribution['vm']['delivery']['prefix_bytes']))
        print('wrote %s (%d bytes, %d-byte authenticated prefix)'
              % (os.path.splitext(out)[0] + '-regions.pages',
                 distribution['vm']['regions']['delivery']['bytes'],
                 distribution['vm']['regions']['delivery']['prefix_bytes']))
        print('wrote %s (%d bytes, %d-byte authenticated prefix)'
              % (os.path.splitext(out)[0] + '-steps.pages',
                 distribution['vm']['steps']['delivery']['bytes'],
                 distribution['vm']['steps']['delivery']['prefix_bytes']))
    print('QM checked %d pure and %d state wasm bodies; %d replaced, '
          '%d memory loads substituted'
          % (report['decoded_pure_integer_expressions'],
             report['decoded_state_integer_expressions'],
             report['replaced'], report['forwarded_memory_loads']))
    print('state pages: %d physical operations total; %d have no typed-wasm '
          'diagnostic spelling'
          % (report['state_physical_work'],
             report['unencodable_state_integer_expressions']))
    print('reencodable state work %d physical -> %d typed wasm '
          '(%d publication/materialization operations)'
          % (report['reencodable_state_physical_work'],
             report['state_reencoded_work'],
             report['reencoded_materializations']))
    if report['rejected_typed_wasm_improvements']:
        print('%d typed-wasm state rewrite(s) rejected; state pages remain '
              'physical'
              % report['rejected_typed_wasm_improvements'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
