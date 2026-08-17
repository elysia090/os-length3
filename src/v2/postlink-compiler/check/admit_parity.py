#!/usr/bin/env python3
"""Prove the C admission path against the Python reader.

`postlink-admit MACHINE --vectors N` prints, for each of the first N blocks:

    rip control boundary first second third guard_offset guard_length
        template_rank step_bytes

all resolved from mapped coordinates without assembling a record.  The Python
reader reconstructs the same blocks the long way -- instantiating templates
and building X86B records -- and the two must agree on every field that
survives the difference.

Usage:
    postlink-admit MACHINE --vectors 20000 | admit_parity.py MACHINE
"""

import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import load_native_x86_machine, NATIVE_BLOCK_HEADER


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: admit_parity.py MACHINE < vectors')
    payload = Path(sys.argv[1]).read_bytes()
    _metadata, _memory, records = load_native_x86_machine(payload)
    records = list(records)

    checked = 0
    for line in sys.stdin:
        line = line.split()
        if not line:
            continue
        (rip, control, boundary, first, second, third,
         _guard_offset, guard_length, _template_rank, step_bytes) = (
            int(value) for value in line)

        if checked >= len(records):
            raise SystemExit('C admitted more blocks than Python reconstructs')
        python_rip, record = records[checked]
        record = bytes(record)
        fields = NATIVE_BLOCK_HEADER.unpack_from(record, 0)
        version, python_step_bytes = fields[1], fields[5]
        python_guard = len(record) - 64 - python_step_bytes
        expected = (
            python_rip, fields[6], fields[4], fields[7], fields[8], fields[9],
            python_guard, python_step_bytes,
        )
        found = (rip, control, boundary, first, second, third,
                 guard_length, step_bytes)
        if expected != found:
            raise SystemExit(
                'block %d at %#x: python %r, C %r (record version %d)'
                % (checked, python_rip, expected, found, version))
        checked += 1

    if not checked:
        raise SystemExit('no vectors on stdin')
    print('admission parity: %d blocks agree' % checked)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
