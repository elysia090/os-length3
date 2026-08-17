#!/usr/bin/env python3
"""Observe what composing two state steps actually produces.

A C composer has to agree with `qm.stepnormalize.compose_plans` on the header of
the composed step, and the header is not the sum of its parts: composition is
substitution, so the second plan's local and stack inputs become the operands
the first plan publishes and no intermediate frame is materialized.

This runs the real composition over the fusible pairs `postlink-trace --pairs`
names and reports, for each header field, how the composed value relates to the
two inputs.  The point is to replace a guess with a measurement before the C
side is written.

Usage:
    postlink-trace MACHINE --pairs 200 | compose_parity.py MACHINE
"""

import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import load_native_x86_machine, NATIVE_BLOCK_HEADER
from qm.steppage import decode_plan, unpack as unpack_step
from qm.stepnormalize import compose_plans, compose_plans_raw

FIELDS = ('function', 'start', 'end', 'instructions', 'span', 'work',
          'operands', 'stack_inputs', 'stack_count', 'local_extent',
          'local_updates')


def plan_of(record):
    record = bytes(record)
    fields = NATIVE_BLOCK_HEADER.unpack_from(record, 0)
    version, step_bytes = fields[1], fields[5]
    if version == 3:
        parameter_bytes, template_bytes = struct.unpack_from('<II', record, 56)
    else:
        parameter_bytes, template_bytes = 0, step_bytes
    guard = len(record) - 64 - parameter_bytes - template_bytes
    step = record[64 + guard + parameter_bytes:]
    return decode_plan(unpack_step(step))


def shape(plan):
    """The eleven header numbers a template stores, read off a plan."""
    return {
        'function': plan.function,
        'start': plan.start,
        'end': plan.end,
        'instructions': plan.end - plan.start,
        'span': plan.waves.span,
        'work': len(plan.nodes),
        'operands': sum(len(node.arguments) for node in plan.nodes),
        'stack_inputs': plan.stack_inputs,
        'stack_count': len(plan.stack),
        'local_extent': len(plan.locals),
        'local_updates': len(plan.locals),
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: compose_parity.py MACHINE < pairs')
    _metadata, _memory, records = load_native_x86_machine(
        Path(sys.argv[1]).read_bytes())
    records = list(records)

    relations = {name: Counter() for name in FIELDS}
    composed_work = 0
    summed_work = 0
    composed_bytes = 0
    pairs = 0
    refused = Counter()

    for line in sys.stdin:
        parts = line.split()
        if len(parts) != 2:
            continue
        head, tail = (int(value) for value in parts)
        if head >= len(records) or tail >= len(records):
            refused['index out of range'] += 1
            continue
        try:
            first = plan_of(records[head][1])
            second = plan_of(records[tail][1])
        except Exception as error:                    # noqa: BLE001
            refused['decode: %s' % type(error).__name__] += 1
            continue
        try:
            joined = compose_plans(first, second)
            raw = compose_plans_raw(first, second)
        except Exception as error:                    # noqa: BLE001
            refused['compose: %s' % error] += 1
            continue

        pairs += 1
        a, b, c = shape(first), shape(second), shape(joined)
        for name in FIELDS:
            # Test equality before sum: when both inputs are zero every
            # relation is true at once, and reporting that as a sum would be
            # a claim the data does not support.
            if a[name] == b[name] == c[name]:
                relations[name]['equal'] += 1
            elif c[name] == a[name]:
                relations[name]['first'] += 1
            elif c[name] == b[name]:
                relations[name]['second'] += 1
            elif c[name] == a[name] + b[name]:
                relations[name]['sum'] += 1
            elif c[name] == max(a[name], b[name]):
                relations[name]['max'] += 1
            elif c[name] < a[name] + b[name]:
                relations[name]['below sum'] += 1
            else:
                relations[name]['above sum'] += 1
        composed_work += c['work']
        summed_work += a['work'] + b['work']
        composed_bytes += len(raw.nodes)

    if not pairs:
        raise SystemExit('no pairs composed; refusals: %r' % dict(refused))

    print('pairs composed              %10d' % pairs)
    if refused:
        for reason, count in refused.most_common(6):
            print('  refused: %-24s %8d' % (reason[:24], count))
    print()
    print('composed header, against the two inputs:')
    for name in FIELDS:
        summary = '  '.join(
            '%s=%d' % (key, value)
            for key, value in relations[name].most_common())
        print('  %-14s %s' % (name, summary))
    print()
    print('work: summed %d, composed %d (%.2fx)'
          % (summed_work, composed_work,
             composed_work / max(summed_work, 1)))
    print('nodes before normalization  %10d' % composed_bytes)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
