"""Compare the startup entropy recurrence with the existing scalar path."""

import argparse
from dataclasses import replace
from pathlib import Path
import struct
from time import perf_counter

from kernel.machine import MachineEvent
from kernel.x86 import (
    IA32_TIME_STAMP_COUNTER,
    MASK32,
    REGISTER_INDEX,
    X86Boundary,
    X86DBT,
    X86Machine,
    advance_virtual_clock,
    _freeze_state,
    load_bzimage_kernel,
    load_virtual,
    read_virtual,
)
from kernel.x86snapshot import load_x86_machine_state
from qm.memorycut import MemoryCut


def _deliver_pending(machine):
    if machine.pending is None:
        return machine
    if machine.pending.operation != 'interrupt':
        raise RuntimeError(
            'checkpoint awaits %s instead of an interrupt'
            % machine.pending.operation)
    runtime = X86Machine(X86DBT())
    return runtime._answer(
        machine,
        MachineEvent('interrupt', machine.pending.coordinate))


def _deliver_boundary(dbt, state, boundary):
    if boundary.operation == 'page_fault':
        fault = boundary.detail
        error = (int(fault.present)
                 | (2 if fault.access == 'write' else 0)
                 | (4 if state.cs & 3 else 0)
                 | (16 if fault.access == 'execute' else 0))
        return dbt._deliver_exception(state, 14, error)
    if boundary.operation == 'exception':
        vector, error_code = boundary.detail
        return dbt._deliver_exception(state, vector, error_code)
    return None


def _clock_response(state, boundary, step, variation_bits):
    value = advance_virtual_clock(
        dict(state.msrs).get(IA32_TIME_STAMP_COUNTER, 0),
        step, variation_bits)
    registers = list(state.registers)
    registers[REGISTER_INDEX['rax']] = value & MASK32
    registers[REGISTER_INDEX['rdx']] = value >> 32
    msrs = dict(state.msrs)
    msrs[IA32_TIME_STAMP_COUNTER] = value
    return replace(
        state, registers=tuple(registers),
        msrs=tuple(sorted(msrs.items())), rip=int(boundary.detail))


def _first_clock(state, step, variation_bits, limit):
    dbt = X86DBT()
    controls = 0
    while controls < limit:
        state, boundary, _cost = dbt.step(state, max_controls=1)
        controls += 1
        if boundary is None:
            continue
        if boundary.operation == 'clock':
            return (_clock_response(
                        state, boundary, step, variation_bits),
                    controls)
        delivered = _deliver_boundary(dbt, state, boundary)
        if delivered is not None:
            state = delivered
            continue
        raise RuntimeError(
            'seeking the first clock stopped at %s: %r'
            % (boundary.operation, boundary.detail))
    raise RuntimeError('the first clock was not reached')


def _scalar_to_rip(state, target, step, variation_bits, limit):
    dbt = X86DBT()
    controls = 0
    clocks = 0
    started = perf_counter()
    while state.rip != target and controls < limit:
        state, boundary, _cost = dbt.step(state, max_controls=1)
        controls += 1
        if boundary is None:
            continue
        if boundary.operation == 'clock':
            state = dbt._collapse_clock_store_return(
                _clock_response(state, boundary, step, variation_bits))
            clocks += 1
            continue
        delivered = _deliver_boundary(dbt, state, boundary)
        if delivered is not None:
            state = delivered
            continue
        raise RuntimeError(
            'scalar execution stopped at %s: %r'
            % (boundary.operation, boundary.detail))
    if state.rip != target:
        raise RuntimeError('scalar execution did not reach the summary cut')
    return state, controls, clocks, perf_counter() - started


def _layout(source):
    pointer = source.register('rsp')
    shuffle_frame = load_virtual(source, pointer + 8, 8)
    memory_frame = load_virtual(source, shuffle_frame, 8)
    measure_frame = load_virtual(source, memory_frame, 8)
    outer_frame = load_virtual(source, measure_frame, 8)
    collector = load_virtual(source, memory_frame - 8, 8)
    descriptor = load_virtual(source, collector, 8)
    memory = load_virtual(source, collector + 0x28, 8)
    blocks = load_virtual(source, collector + 0x34, 4)
    block_bytes = load_virtual(source, collector + 0x38, 4)
    transform = load_virtual(source, descriptor, 8)
    algorithm = load_virtual(source, transform + 0x20, 8)
    context_bytes = load_virtual(source, algorithm - 0x10, 4)
    rate_bytes = load_virtual(source, algorithm + 0x24, 4)
    return {
        'outer_frame': outer_frame,
        'collector': collector,
        'descriptor': descriptor,
        'memory': memory,
        'wrap': blocks * block_bytes,
        'context_bytes': context_bytes,
        'rate_bytes': rate_bytes,
    }


def _first_byte_difference(left, right):
    for index, (wanted, found) in enumerate(zip(left, right)):
        if wanted != found:
            return index, wanted, found
    if len(left) != len(right):
        return min(len(left), len(right)), None, None
    return None


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('bzimage', type=Path)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('--initrd', type=Path)
    parser.add_argument('--command-line')
    parser.add_argument('--memory-mib', type=int, default=128)
    parser.add_argument('--clock-step', type=int, default=1 << 20)
    parser.add_argument('--clock-variation-bits', type=int, default=12)
    parser.add_argument('--control-limit', type=int, default=1 << 22)
    arguments = parser.parse_args(argv)

    boot = load_bzimage_kernel(
        arguments.bzimage.read_bytes(),
        memory_bytes=arguments.memory_mib << 20,
        initrd=(None if arguments.initrd is None
                else arguments.initrd.read_bytes()),
        command_line=arguments.command_line)
    machine = load_x86_machine_state(
        arguments.checkpoint.read_bytes(), boot.state.memory)

    class FoundEntropyClock(Exception):
        pass

    seek_dbt = X86DBT()
    captured = []
    startup_signature = bytes.fromhex(
        '0f 1f 44 00 00 55 48 89 e5 48 83 ec 68')

    def capture_entropy_clock(state, step, variation_bits):
        try:
            pointer = state.register('rsp')
            shuffle_frame = load_virtual(state, pointer + 8, 8)
            memory_frame = load_virtual(state, shuffle_frame, 8)
            measure_frame = load_virtual(state, memory_frame, 8)
            generator_return = load_virtual(state, measure_frame + 8, 8)
            startup = (generator_return - 0xf8) & ((1 << 64) - 1)
            signature = read_virtual(
                state, startup + 4, len(startup_signature), 'execute')
        except Exception:
            return None
        if signature != startup_signature:
            return None
        captured.append(_freeze_state(state))
        raise FoundEntropyClock()

    seek_dbt._collapse_entropy_recurrence = capture_entropy_clock
    seek_runtime = X86Machine(seek_dbt)
    response = None
    if machine.pending is not None:
        if machine.pending.operation != 'interrupt':
            raise RuntimeError(
                'checkpoint awaits %s instead of an interrupt'
                % machine.pending.operation)
        response = MachineEvent('interrupt', machine.pending.coordinate)
    try:
        seek_runtime.machine_step(
            machine, response, budget=1 << 22,
            max_internal=1024,
            clock_step=arguments.clock_step,
            clock_variation_bits=arguments.clock_variation_bits)
    except FoundEntropyClock:
        pass
    if not captured:
        raise RuntimeError('the startup entropy clock was not reached')
    captured_state = captured[0]
    base_memory = (captured_state.memory.commit()
                   if isinstance(captured_state.memory, MemoryCut)
                   else captured_state.memory)
    source = replace(captured_state, memory=MemoryCut(base_memory))
    scalar_source = replace(captured_state, memory=MemoryCut(base_memory))
    seek_controls = seek_dbt.threaded_controls

    summary_dbt = X86DBT()
    started = perf_counter()
    collapsed = summary_dbt._collapse_entropy_recurrence(
        source, arguments.clock_step, arguments.clock_variation_bits)
    summary_seconds = perf_counter() - started
    if collapsed is None:
        raise RuntimeError('the first clock is not an entropy recurrence')
    summary, extra_clocks = collapsed
    scalar, scalar_controls, scalar_clocks, scalar_seconds = _scalar_to_rip(
        scalar_source, summary.rip,
        arguments.clock_step, arguments.clock_variation_bits,
        arguments.control_limit)

    layout = _layout(source)
    buffered_address = (layout['descriptor'] + 8
                        + layout['context_bytes'] - 1)
    buffer_address = buffered_address - layout['rate_bytes']
    scalar_tail = load_virtual(scalar, buffered_address, 1)
    summary_tail = load_virtual(summary, buffered_address, 1)
    regions = (
        ('collector', layout['collector'], 0x60),
        ('sponge-lanes', layout['descriptor'] + 8, 200),
        ('sponge-tail', buffer_address, max(scalar_tail, summary_tail)),
        ('sponge-tail-size', buffered_address, 1),
        ('byte-domain', layout['memory'], layout['wrap']),
        ('startup-locals', layout['outer_frame'] - 0x68, 0x68),
    )
    differences = []
    for name, address, size in regions:
        difference = _first_byte_difference(
            read_virtual(scalar, address, size),
            read_virtual(summary, address, size))
        if difference is not None:
            differences.append((name, address, difference))

    live_registers = ('rbx', 'rbp', 'rsp', 'r12', 'r13', 'r14', 'r15')
    register_differences = tuple(
        (name, scalar.register(name), summary.register(name))
        for name in live_registers
        if scalar.register(name) != summary.register(name))
    scalar_tsc = dict(scalar.msrs).get(IA32_TIME_STAMP_COUNTER, 0)
    summary_tsc = dict(summary.msrs).get(IA32_TIME_STAMP_COUNTER, 0)

    print('seek_controls=%d' % seek_controls)
    print('target_rip=0x%x' % summary.rip)
    print('summary_seconds=%.6f' % summary_seconds)
    print('scalar_seconds=%.6f' % scalar_seconds)
    print('scalar_controls=%d' % scalar_controls)
    print('summary_clock_events=%d' % (extra_clocks + 1))
    print('scalar_clock_events=%d' % (scalar_clocks + 1))
    print('live_register_differences=%r' % (register_differences,))
    print('live_memory_differences=%r' % (tuple(differences),))
    print('tsc_equal=%r' % (scalar_tsc == summary_tsc))
    return int(bool(register_differences or differences
                    or scalar_tsc != summary_tsc))


if __name__ == '__main__':
    raise SystemExit(main())
