#!/usr/bin/env python3
"""Create a compact linked Wasm runtime without changing guest semantics."""

import argparse
import json
import mmap
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qm.wasmbinary import (optimize_module, section_layout,
                           strip_custom_sections)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('module')
    parser.add_argument('--out')
    parser.add_argument('--max-body', type=int, default=4096)
    parser.add_argument('--keep-custom', action='append', default=[])
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)

    source_path = Path(args.module)
    with source_path.open('rb') as handle:
        source = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
        input_layout = section_layout(source)
        semantic, removed = strip_custom_sections(
            source, keep=args.keep_custom)
        source_bytes = len(source)
        source.close()
    compact, qm = optimize_module(semantic, args.max_body)
    if args.out:
        Path(args.out).write_bytes(compact)
    report = {
        'input': input_layout,
        'qm': dict((key, value) for key, value in qm.items()
                   if key != 'replacements'),
        'removed_custom_sections': [
            {'name': section.name, 'bytes': section.size}
            for section in removed
        ],
        'output': section_layout(compact),
        'saved_bytes': source_bytes - len(compact),
        'materialization': {
            'source': 'read-only mmap',
            'mapped_input_bytes': source_bytes,
            'full_source_heap_copy_bytes': 0,
            'bytes_copied_before_qm': len(semantic),
            'custom_bytes_skipped_without_copy':
                source_bytes - len(semantic),
            'semantic_input_reused_when_qm_has_no_replacements':
                compact is semantic,
        },
    }
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print('%s: %d -> %d bytes (%d removed)'
              % (Path(args.module).name, source_bytes, len(compact),
                 report['saved_bytes']))
        for item in sorted(report['removed_custom_sections'],
                           key=lambda value: -value['bytes']):
            print('  %-32s %d' % (item['name'], item['bytes']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
