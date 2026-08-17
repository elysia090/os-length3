#!/usr/bin/env python3
"""Repair faultable terminal retry coordinates in a native x86 machine."""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import repair_native_x86_fault_boundaries


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args(argv)

    migrated, report = repair_native_x86_fault_boundaries(
        arguments.input.read_bytes())
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(migrated)
    report = {
        **report,
        'bytes_before': arguments.input.stat().st_size,
        'bytes_after': len(migrated),
        'output': str(arguments.output),
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
