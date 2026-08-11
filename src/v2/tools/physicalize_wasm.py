#!/usr/bin/env python3
"""Report the columnar physical layout of a WebAssembly module."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qm.wasmphysical import summarize_binary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('module')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    report = summarize_binary(Path(args.module).read_bytes())
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print('%s: %d functions, %d instructions, %d opcode groups'
              % (Path(args.module).name, report['functions'],
                 report['instructions'], report['opcode_dictionary']))
        print('  %d sequential next coordinates derived, %d stored'
              % (report['derived_next_coordinates'],
                 report['next_coordinate_storage']))
        print('  %d pure grammar instructions, %d barriers (%.2f%% pure)'
              % (report['grammar_pure_instructions'],
                 report['grammar_barrier_instructions'],
                 100.0 * report['grammar_pure_ratio']))
        if report['barrier_groups']:
            print('  barrier groups: %s' % ', '.join(
                '%s=%d' % item
                for item in list(report['barrier_groups'].items())[:12]))
        for name, count in sorted(report['opcode_groups'].items(),
                                  key=lambda item: (-item[1], item[0]))[:20]:
            print('  %-20s %d' % (name, count))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
