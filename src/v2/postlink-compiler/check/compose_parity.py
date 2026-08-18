#!/usr/bin/env python3
"""Hold the C composer to qm.stepnormalize.compose_plans_raw.

`postlink-compose MACHINE --vectors N` prints the composed graph of the first N
fusible pairs:

    PAIR head tail function start end instructions stack_inputs nodes args
    N value opcode kind:value ...
    S slot kind:value
    L slot kind:value

Every one is recomposed here through the reference and compared node for node,
argument for argument.  Composition is substitution, and its three mechanisms --
operand replacement, the memory ordering edge, and materializing a projection
whose source does not publish it -- are all things a plausible-looking C
implementation can get subtly wrong, so nothing is taken on inspection.

Usage:
    postlink-compose MACHINE --vectors 400 | compose_parity.py MACHINE
"""

import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import load_native_x86_machine, NATIVE_BLOCK_HEADER
from qm.steppage import OPS, OPERAND_KINDS, decode_plan, unpack as unpack_step
from qm.stepnormalize import (_compact_once, _rewrite_physical,
                              compose_plans_raw)

KIND_CODE = {name: code for code, name in enumerate(OPERAND_KINDS)}
OP_CODE = {name: code for code, name in enumerate(OPS)}


def plan_of(record):
    record = bytes(record)
    fields = NATIVE_BLOCK_HEADER.unpack_from(record, 0)
    version, step_bytes = fields[1], fields[5]
    if version == 3:
        parameter_bytes, template_bytes = struct.unpack_from('<II', record, 56)
    else:
        parameter_bytes, template_bytes = 0, step_bytes
    guard = len(record) - 64 - parameter_bytes - template_bytes
    return decode_plan(unpack_step(record[64 + guard + parameter_bytes:]))


def operand_pairs(operands):
    return [(KIND_CODE[item.kind], int(item.value)) for item in operands]


def reference(plan):
    """The same shape the C tool prints, so the two compare directly."""
    return {
        'header': (plan.function, plan.start, plan.end, plan.instructions,
                   plan.stack_inputs, len(plan.nodes),
                   sum(len(node.arguments) for node in plan.nodes)),
        'nodes': [(OP_CODE[node.op], operand_pairs(node.arguments))
                  for node in plan.nodes],
        'stack': operand_pairs(plan.stack),
        'locals': operand_pairs(plan.locals),
    }


def read_vectors(stream):
    current = None
    for line in stream:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == 'PAIR':
            if current is not None:
                yield current
            values = [int(value) for value in parts[1:]]
            current = {
                'head': values[0], 'tail': values[1],
                'header': tuple(values[2:9]),
                'nodes': [], 'stack': [], 'locals': [],
            }
        elif parts[0] == 'N':
            arguments = [tuple(int(half) for half in item.split(':'))
                         for item in parts[3:]]
            current['nodes'].append((int(parts[2]), arguments))
        elif parts[0] in ('S', 'L'):
            kind, value = (int(half) for half in parts[2].split(':'))
            current['stack' if parts[0] == 'S' else 'locals'].append(
                (kind, value))
    if current is not None:
        yield current


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: compose_parity.py MACHINE [--compact] < vectors')
    compacted = '--compact' in sys.argv
    _metadata, _memory, records = load_native_x86_machine(
        Path(sys.argv[1]).read_bytes())
    records = list(records)

    checked = 0
    skipped = [0]
    disagreements = Counter()
    for vector in read_vectors(sys.stdin):
        head, tail = vector['head'], vector['tail']
        first, second = plan_of(records[head][1]), plan_of(records[tail][1])
        try:
            raw = compose_plans_raw(first, second)
        except Exception as error:                    # noqa: BLE001
            disagreements['python refused where C composed: %s' % error] += 1
            continue
        if compacted:
            # C has no rewriter yet, so compare only where the reference
            # rewriter is the identity; anywhere else the two are being asked
            # different questions.
            rewritten = _rewrite_physical(raw.nodes, raw.stack, raw.locals)
            if (tuple(rewritten[0]) != tuple(raw.nodes)
                    or tuple(rewritten[1]) != tuple(raw.stack)
                    or tuple(rewritten[2]) != tuple(raw.locals)):
                skipped[0] += 1
                continue
            nodes, waves, stack, locals_ = _compact_once(
                raw.nodes, raw.stack, raw.locals)
            raw = raw.__class__(raw.function, raw.start, raw.end,
                                raw.instructions, raw.stack_inputs,
                                nodes, waves, stack, locals_)
        expected = reference(raw)

        if expected['header'] != vector['header']:
            disagreements['header'] += 1
            print('HEADER %d -> %d: python %r, C %r'
                  % (head, tail, expected['header'], vector['header']),
                  file=sys.stderr)
        elif expected['nodes'] != vector['nodes']:
            disagreements['nodes'] += 1
            for index, (want, got) in enumerate(
                    zip(expected['nodes'], vector['nodes'])):
                if want != got:
                    print('NODE %d -> %d at %d: python %r, C %r'
                          % (head, tail, index + 1, want, got),
                          file=sys.stderr)
                    break
        elif expected['stack'] != vector['stack']:
            disagreements['stack'] += 1
        elif expected['locals'] != vector['locals']:
            disagreements['locals'] += 1
            print('LOCALS %d -> %d: python %r, C %r'
                  % (head, tail, expected['locals'][:6],
                     vector['locals'][:6]), file=sys.stderr)
        checked += 1

    if not checked:
        raise SystemExit('no vectors on stdin')
    print('composed pairs compared     %10d' % checked)
    if skipped[0]:
        print('  skipped, rewriter fired   %10d' % skipped[0])
    if disagreements:
        for reason, count in disagreements.most_common(8):
            print('  %-40s %8d' % (reason[:40], count))
        return 1
    print('every graph agrees with the reference')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
