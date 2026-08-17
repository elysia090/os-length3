#!/usr/bin/env python3
"""Add direct-call return coordinates to a native x86 machine directory."""

import argparse
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import repair_native_x86_call_continuations
from tools.close_native_x86_runtime import load_seed_catalog


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('machine', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--coordinates-output', type=Path)
    parser.add_argument('--catalog', type=Path)
    parser.add_argument('--source-elf', type=Path)
    arguments = parser.parse_args(argv)

    payload, report = repair_native_x86_call_continuations(
        arguments.machine.read_bytes())
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(payload)
    return_coordinates = report.pop('return_coordinates')
    if (arguments.catalog is None) != (arguments.source_elf is None):
        parser.error('--catalog and --source-elf must be used together')
    if arguments.catalog is not None:
        identity = hashlib.sha256(
            arguments.source_elf.read_bytes()).digest()
        wanted = set(return_coordinates)
        filtered = []
        for object_identity, pages in load_seed_catalog(arguments.catalog):
            if object_identity != identity:
                continue
            for page, _digest, entries in pages:
                filtered.extend(
                    page + offset for offset in entries
                    if page + offset in wanted)
        return_coordinates = sorted(set(filtered))
    if arguments.coordinates_output is not None:
        arguments.coordinates_output.parent.mkdir(parents=True, exist_ok=True)
        arguments.coordinates_output.write_text(
            ''.join('0x%016x\n' % coordinate
                    for coordinate in return_coordinates),
            encoding='utf-8', newline='\n')
    report.update({
        'input_bytes': arguments.machine.stat().st_size,
        'output_bytes': len(payload),
        'output': str(arguments.output),
        'return_coordinates': len(return_coordinates),
    })
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
