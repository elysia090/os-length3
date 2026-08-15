#!/usr/bin/env python3
"""Repack a native x86 machine into block quotient schema v5."""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.pagefabric import PageFabric, open_artifact, write_artifact
from kernel.x86snapshot import (load_native_x86_physical_machine,
                                repack_native_x86_machine)


def _catalog(artifact_root, name):
    catalog_path = artifact_root / 'index.json'
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    entry = catalog['artifacts'][name]
    return catalog, entry


def _open(artifact_root, name, entry):
    index = json.loads(
        (artifact_root / entry['path']).read_text(encoding='utf-8'))
    manifest, store = open_artifact(index, artifact_root, name)
    fabric = PageFabric(manifest, (store,))
    return fabric.read(0, fabric.length)


def repack(artifact_root, name, output=None, publish=False, source_path=None,
           source_name='linux-x86-64'):
    artifact_root = Path(artifact_root)
    catalog, entry = _catalog(artifact_root, name)
    source = (Path(source_path).read_bytes() if source_path is not None
              else _open(artifact_root, name, entry))
    before, _memory, before_records = \
        load_native_x86_physical_machine(source)
    payload = repack_native_x86_machine(source)
    after, _memory, after_records = \
        load_native_x86_physical_machine(payload)
    if output is not None:
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(payload)
    result = {
        'schema_before': int(before['schema']),
        'schema_after': int(after['schema']),
        'bytes_before': len(source),
        'bytes_after': len(payload),
        'records': len(after_records),
        'unique_steps': int(after['step_identity']['unique']),
        'shared_records': int(after['step_identity']['shared']),
        'unique_step_templates': int(
            after['step_template_identity']['unique']),
        'shared_step_instances': int(
            after['step_template_identity']['shared']),
        'unique_continuations': int(
            after['continuation_identity']['unique']),
        'shared_continuations': int(
            after['continuation_identity']['shared']),
        'template_bytes': int(after['template_execution_bytes']),
        'parameter_bytes': int(after['parameter_execution_bytes']),
        'descriptor_bytes': int(after['descriptor_bytes']),
        'execution_bytes': int(after['execution_bytes']),
    }
    if len(before_records) != len(after_records):
        raise RuntimeError('native x86 repack changed the record directory')
    if publish:
        source_entry = catalog['artifacts'].get(source_name)
        if not isinstance(source_entry, dict) \
                or not isinstance(source_entry.get('identity'), str):
            raise ValueError('native x86 source artifact is not published')
        written = write_artifact(
            payload, artifact_root, name, page_bytes=1 << 16,
            included_shards='data', replace=True)
        catalog['artifacts'][name] = {
            **entry,
            'bytes': len(payload),
            'format': 'x86-native-machine-v5',
            'identity': written['identity']['digest'],
            'source_identity': source_entry['identity'],
        }
        catalog['artifacts'] = dict(sorted(catalog['artifacts'].items()))
        (artifact_root / 'index.json').write_text(
            json.dumps(catalog, indent=2, sort_keys=True) + '\n',
            encoding='utf-8', newline='\n')
        result['identity'] = written['identity']['digest']
        result['delivery'] = written['preferred']
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--name', default='linux-x86-64-machine')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--input', type=Path,
                        help='repack these canonical machine bytes')
    parser.add_argument('--source', default='linux-x86-64',
                        help='boot artifact named by the machine memory')
    parser.add_argument('--publish', action='store_true')
    arguments = parser.parse_args(argv)
    print(json.dumps(repack(
        arguments.artifact_root, arguments.name,
        arguments.output, arguments.publish, arguments.input,
        arguments.source),
        indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
