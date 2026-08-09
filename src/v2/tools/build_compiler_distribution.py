#!/usr/bin/env python3
"""Build a standalone, content-addressed compiler distribution.

The inputs may come from an installed toolchain package, but the output has no
runtime package dependency:

    compiler.wasm
    compiler-resources.tar
    compiler.json
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qm.wasmbinary import optimize_module


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def build(core, resources, output, version, max_body=4096):
    core = Path(core)
    resources = Path(resources)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)

    source_hash = digest(core)
    optimized, report = optimize_module(core.read_bytes(), max_body=max_body)
    compiler = output / 'compiler.wasm'
    compiler.write_bytes(optimized)

    resource_output = output / 'compiler-resources.tar'
    with resources.open('rb') as source, resource_output.open('wb') as target:
        shutil.copyfileobj(source, target, length=1024 * 1024)

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
            'bytes': compiler.stat().st_size,
            'sha256': digest(compiler),
            'source_sha256': source_hash,
        },
        'resources': {
            'file': resource_output.name,
            'bytes': resource_output.stat().st_size,
            'sha256': digest(resource_output),
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
    args = parser.parse_args(argv)
    manifest = build(args.core, args.resources, args.out, args.version,
                     max_body=args.max_body)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
