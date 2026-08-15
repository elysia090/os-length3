#!/usr/bin/env python3
"""Union native x86 block quotients while retaining one cold-boot image."""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import merge_native_x86_physical_machines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base', type=Path,
                        help='machine that owns cold-boot state and RAM')
    parser.add_argument('overlays', type=Path, nargs='+',
                        help='machines whose guarded block quotients are added')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument(
        '--replace-conflicts', action='store_true',
        help=('let a later overlay replace an existing lowering for the same '
              'guarded coordinate; cold-boot packaging keeps the base'))
    arguments = parser.parse_args(argv)

    payload, report = merge_native_x86_physical_machines(
        arguments.base.read_bytes(),
        *(path.read_bytes() for path in arguments.overlays),
        replace_conflicts=arguments.replace_conflicts,
    )
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(payload)
    report['bytes'] = len(payload)
    report['output'] = str(arguments.output)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
