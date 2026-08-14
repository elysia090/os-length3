#!/usr/bin/env python3
"""Inspect raw and physical x86 cuts at a saved native runtime state."""

import argparse
from dataclasses import replace
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86 import X86DBT, read_virtual
from qm.stepnormalize import physical_work
from tools.close_native_x86_runtime import load_runtime_cut


def _hex_prefix(payload, limit=96):
    payload = bytes(payload)
    prefix = payload[:limit].hex()
    return prefix + ('...(+%d bytes)' % (len(payload) - limit)
                     if len(payload) > limit else '')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--address', type=lambda value: int(value, 0))
    parser.add_argument('--bytes', type=int, default=128)
    parser.add_argument('--data-address', action='append', default=[],
                        type=lambda value: int(value, 0),
                        help='read one virtual data coordinate (repeatable)')
    parser.add_argument('--data-bytes', type=int, default=32)
    parser.add_argument('--compare-until', type=lambda value: int(value, 0),
                        help='compare composed and scalar states at this RIP')
    arguments = parser.parse_args(argv)

    machine, _identity, _dirty = load_runtime_cut(
        arguments.artifact_root, arguments.source, arguments.snapshot)
    for address in arguments.data_address:
        payload = read_virtual(
            machine.cpu, address, max(0, arguments.data_bytes), 'read')
        print('data[%#x]=%s' % (address, payload.hex()))
    if arguments.address is None:
        return 0
    state = replace(machine.cpu, rip=arguments.address)
    source = read_virtual(
        state, arguments.address, max(0, arguments.bytes), 'execute')
    dbt = X86DBT(profile_controls=True)
    raw = dbt.block(state)
    physical = dbt.physical_block(state)
    print('code[%#x]=%s' % (arguments.address, _hex_prefix(source)))
    for name, block in (('raw', raw), ('physical', physical)):
        print('%s rip=%#x boundary_rip=%#x instructions=%d source_bytes=%d '
              'source=%s'
              % (name, block.rip, block.boundary_rip,
                 block.instructions, len(block.source),
                 _hex_prefix(block.source)))
        print('%s work=%d span=%d nodes=%s' % (
            name, physical_work(block.plan), block.plan.waves.span,
            ','.join(node.op for node in block.plan.nodes) or '-'))
        for node in block.plan.nodes:
            print('%s node[%d]=%s(%s)' % (
                name, node.value, node.op, ', '.join(
                    '%s:%#x' % (operand.kind, operand.value)
                    for operand in node.arguments)))
        print('%s stack=%s locals=%s' % (
            name,
            ','.join('%s:%#x' % (item.kind, item.value)
                     for item in block.plan.stack) or '-',
            ','.join('%d=%s:%#x' % (index, item.kind, item.value)
                     for index, item in enumerate(block.plan.locals)) or '-'))
        print('%s code_extents=%s' % (name, ','.join(
            '%#x+%d' % (address, len(payload))
            for address, payload in block.code_extents)))
        print('%s boundary=%r' % (name, block.boundary))
    if arguments.compare_until is not None:
        def reached(candidate, scalar=False):
            engine = X86DBT(profile_controls=True)
            if scalar:
                engine._compose_register_cut = \
                    lambda _state, block: block
            current = state
            for controls in range(1, 257):
                current, boundary, _cost = engine.step(
                    current, max_controls=1)
                if current.rip == arguments.compare_until:
                    return current, boundary, controls
                if boundary is not None:
                    raise RuntimeError(
                        '%s path published %r before target'
                        % ('scalar' if scalar else 'physical', boundary))
            raise RuntimeError('comparison target was not reached')

        for name, scalar in (('physical-state', False),
                             ('scalar-state', True)):
            current, boundary, controls = reached(state, scalar)
            print('%s controls=%d boundary=%r rflags=%#x'
                  % (name, controls, boundary, current.rflags))
            print('%s registers=%s' % (name, ' '.join(
                '%x' % value for value in current.registers)))
            stack = read_virtual(
                current, current.register('rsp'), 128, 'read')
            print('%s stack[%#x]=%s' % (
                name, current.register('rsp'), stack.hex()))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
