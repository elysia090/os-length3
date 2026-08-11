"""Compare the x86 jitter-entropy summary with scalar DBT execution."""

import argparse
import base64
from dataclasses import fields, replace
import json
from pathlib import Path
import struct
import subprocess
from time import perf_counter

from kernel.x86 import (
    IA32_TIME_STAMP_COUNTER,
    MASK32,
    REGISTER_INDEX,
    REGISTER_NAMES,
    X86Boundary,
    X86DBT,
    X86Machine,
    advance_virtual_clock,
    load_bzimage_kernel,
    load_virtual,
    read_virtual,
    translate,
)
from kernel.x86snapshot import load_x86_machine_state
from kernel.browser import X86BrowserSession
from qm.memorycut import MemoryCut
from qm.wasmstate import MEMORY_PAGE


def _answer_clock(state, boundary, step, variation_bits, dbt):
    value = advance_virtual_clock(
        dict(state.msrs).get(IA32_TIME_STAMP_COUNTER, 0),
        step, variation_bits)
    registers = list(state.registers)
    registers[REGISTER_INDEX['rax']] = value & MASK32
    registers[REGISTER_INDEX['rdx']] = value >> 32
    msrs = dict(state.msrs)
    msrs[IA32_TIME_STAMP_COUNTER] = value
    state = replace(
        state, registers=tuple(registers),
        msrs=tuple(sorted(msrs.items())), rip=int(boundary.detail))
    return dbt._collapse_clock_store_return(state)


def _scalar_to_rip(state, target, step, variation_bits, limit):
    dbt = X86DBT()
    sponge_trace = []
    sponge = dbt._collapse_sponge_mix_call

    def trace_sponge(current, following, call_target):
        result = sponge(current, following, call_target)
        if result is not None and not sponge_trace:
            stack = current.register('rsp')
            scratch = ((((stack - 56) & ((1 << 64) - 1)) & ~0xf)
                       - 0x1d0) & ((1 << 64) - 1)
            seed = (scratch + 0x20) & ((1 << 64) - 1)
            sponge_trace.append((
                stack, scratch, seed, read_virtual(current, seed, 32)))
        return result

    dbt._collapse_sponge_mix_call = trace_sponge
    clocks = 0
    controls = 0
    started = perf_counter()
    while state.rip != target:
        if controls >= limit:
            raise RuntimeError('scalar comparison did not reach the target')
        state, boundary, _cost = dbt.step(state, max_controls=1)
        controls += 1
        if boundary is None:
            continue
        if boundary.operation == 'clock':
            state = _answer_clock(
                state, boundary, step, variation_bits, dbt)
            clocks += 1
            continue
        if boundary.operation == 'page_fault':
            fault = boundary.detail
            error = (int(fault.present)
                     | (2 if fault.access == 'write' else 0)
                     | (4 if state.cs & 3 else 0)
                     | (16 if fault.access == 'execute' else 0))
            delivered = dbt._deliver_exception(state, 14, error)
            if delivered is None:
                raise RuntimeError('scalar comparison could not deliver a page fault')
            state = delivered
            continue
        if boundary.operation == 'exception':
            vector, error_code = boundary.detail
            delivered = dbt._deliver_exception(state, vector, error_code)
            if delivered is None:
                raise RuntimeError('scalar comparison could not deliver an exception')
            state = delivered
            continue
        if isinstance(boundary, X86Boundary):
            raise RuntimeError(
                'scalar comparison stopped at %s: %r'
                % (boundary.operation, boundary.detail))
    return state, clocks, controls, perf_counter() - started, sponge_trace


def _persistent(state):
    memory = state.memory.commit() if isinstance(
        state.memory, MemoryCut) else state.memory
    return replace(state, memory=memory)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('bzimage', type=Path)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('--memory-mib', type=int, default=128)
    parser.add_argument('--clock-step', type=int, default=1024)
    parser.add_argument('--clock-variation-bits', type=int, default=12)
    parser.add_argument('--control-limit', type=int, default=1 << 22)
    parser.add_argument('--summary-only', action='store_true')
    parser.add_argument('--digest-profile', action='store_true')
    parser.add_argument('--browser-step', action='store_true')
    parser.add_argument('--wasm-sponge', type=Path)
    arguments = parser.parse_args(argv)

    sponge_records = None
    if arguments.wasm_sponge is not None:
        runner = Path(__file__).with_name('sponge_records.mjs')

        def sponge_records(lanes, tail, seed, records, rounds,
                           rate_bytes, digest_bytes):
            if rate_bytes != 136 or digest_bytes != 32:
                raise RuntimeError('the Wasm cut is SHA3-256')
            packed_records = b''.join(
                bytes(additional) + struct.pack('<Q', int(time_value))
                for additional, time_value in records)
            request = {
                'lanes': base64.b64encode(
                    struct.pack('<25Q', *lanes)).decode('ascii'),
                'tail': base64.b64encode(bytes(tail)).decode('ascii'),
                'seed': base64.b64encode(bytes(seed)).decode('ascii'),
                'records': base64.b64encode(packed_records).decode('ascii'),
                'rounds': int(rounds),
            }
            result = subprocess.run(
                ['node', str(runner), str(arguments.wasm_sponge)],
                input=json.dumps(request), capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(result.stderr.strip())
            output = json.loads(result.stdout)
            lane_bytes = base64.b64decode(output['lanes'], validate=True)
            return (struct.unpack('<25Q', lane_bytes),
                    base64.b64decode(output['tail'], validate=True))

    image = arguments.bzimage.read_bytes()
    boot = load_bzimage_kernel(
        image, memory_bytes=arguments.memory_mib << 20)
    machine = load_x86_machine_state(
        arguments.checkpoint.read_bytes(), boot.state.memory)
    if arguments.browser_step:
        runtime = X86Machine(X86DBT(sponge_records=sponge_records))
        session = X86BrowserSession(
            runtime, machine,
            arguments.clock_step, arguments.clock_variation_bits)
        started = perf_counter()
        boundary = session.step(
            budget=1 << 21, max_internal=1024)
        seconds = perf_counter() - started
        print('browser_step_seconds=%.6f' % seconds)
        print('browser_event=%s'
              % (None if boundary is None else boundary.operation))
        print('collapsed_entropy_measurements=%d'
              % runtime.dbt.collapsed_entropy_measurements)
        print('collapsed_entropy_clock_events=%d'
              % runtime.dbt.collapsed_entropy_clock_events)
        print('affine_clock_events=%d' % runtime.affine_clock_events)
        return 0
    source = replace(machine.cpu, memory=MemoryCut(machine.cpu.memory))

    summary_dbt = X86DBT(sponge_records=sponge_records)
    digest_inputs = set()
    digest_suffixes = set()
    digest_calls = 0
    if arguments.digest_profile:
        digest = summary_dbt._sponge_digest

        def profile_digest(payload, rate_bytes, digest_bytes):
            nonlocal digest_calls
            digest_calls += 1
            digest_inputs.add(bytes(payload))
            if len(payload) >= 16:
                digest_suffixes.add(bytes(payload[-16:]))
            return digest(payload, rate_bytes, digest_bytes)

        summary_dbt._sponge_digest = profile_digest
    started = perf_counter()
    collapsed = summary_dbt._collapse_entropy_recurrence(
        source, arguments.clock_step, arguments.clock_variation_bits)
    summary_seconds = perf_counter() - started
    if collapsed is None:
        raise RuntimeError('checkpoint is not an entropy-recurrence coordinate')
    summary, extra_clocks = collapsed
    if arguments.summary_only:
        print('target_rip=0x%x' % summary.rip)
        print('summary_seconds=%.6f' % summary_seconds)
        print('summary_clock_events=%d' % (extra_clocks + 1))
        print('summary_measurements=%d'
              % summary_dbt.collapsed_entropy_measurements)
        if arguments.digest_profile:
            print('digest_calls=%d' % digest_calls)
            print('digest_unique_inputs=%d' % len(digest_inputs))
            print('digest_unique_suffixes=%d' % len(digest_suffixes))
        return 0

    scalar, scalar_clocks, controls, scalar_seconds, sponge_trace = _scalar_to_rip(
        replace(machine.cpu, memory=MemoryCut(machine.cpu.memory)),
        summary.rip, arguments.clock_step, arguments.clock_variation_bits,
        arguments.control_limit)
    summary = _persistent(summary)
    scalar = _persistent(scalar)
    differences = tuple(
        field.name for field in fields(summary)
        if field.compare and getattr(summary, field.name) != getattr(scalar, field.name))

    print('target_rip=0x%x' % summary.rip)
    print('summary_seconds=%.6f' % summary_seconds)
    print('scalar_seconds=%.6f' % scalar_seconds)
    print('summary_clock_events=%d' % (extra_clocks + 1))
    print('scalar_clock_events=%d' % scalar_clocks)
    print('scalar_controls=%d' % controls)
    print('first_sponge=%r' % (tuple(
        (hex(stack), hex(scratch), hex(seed), payload.hex())
        for stack, scratch, seed, payload in sponge_trace),))
    print('differences=%r' % (differences,))
    if summary.registers != scalar.registers:
        print('register_differences=%r' % (tuple(
            (name, summary.registers[index], scalar.registers[index])
            for index, name in enumerate(REGISTER_NAMES)
            if summary.registers[index] != scalar.registers[index]),))
    if summary.rflags != scalar.rflags:
        print('rflags=summary:0x%x scalar:0x%x'
              % (summary.rflags, scalar.rflags))
    live_memory_bytes = ()
    if summary.memory != scalar.memory:
        pages = scalar.memory.difference(summary.memory)
        bytes_ = []
        for page, scalar_value in pages:
            summary_value = summary.memory.read(page * MEMORY_PAGE, MEMORY_PAGE)
            bytes_.extend(
                (page * MEMORY_PAGE + offset,
                 summary_value[offset], scalar_value[offset])
                for offset in range(MEMORY_PAGE)
                if summary_value[offset] != scalar_value[offset])
            if len(bytes_) >= 64:
                break
        print('memory_pages=%d' % len(pages))
        print('memory_bytes=%r' % (tuple(bytes_[:64]),))
        collector = summary.register('rdx')
        descriptor = load_virtual(summary, collector, 8)
        transform = load_virtual(summary, descriptor, 8)
        algorithm = load_virtual(summary, transform + 0x20, 8)
        context_bytes = load_virtual(summary, algorithm - 0x10, 4)
        rate_bytes = load_virtual(summary, algorithm + 0x24, 4)
        buffered = descriptor + 8 + context_bytes - 1
        buffer = buffered - rate_bytes
        summary_count = load_virtual(summary, buffered, 1)
        scalar_count = load_virtual(scalar, buffered, 1)
        extent = max(summary_count, scalar_count)
        print('sponge=descriptor:0x%x buffer:0x%x count:%d/%d lanes_equal:%r'
              % (descriptor, buffer, summary_count, scalar_count,
                 read_virtual(summary, descriptor + 8, 200)
                 == read_virtual(scalar, descriptor + 8, 200)))
        print('sponge_buffer=summary:%s scalar:%s' % (
            read_virtual(summary, buffer, extent).hex(),
            read_virtual(scalar, buffer, extent).hex()))

        all_bytes = []
        for page, scalar_value in pages:
            summary_value = summary.memory.read(page * MEMORY_PAGE, MEMORY_PAGE)
            all_bytes.extend(
                (page * MEMORY_PAGE + offset,
                 summary_value[offset], scalar_value[offset])
                for offset in range(MEMORY_PAGE)
                if summary_value[offset] != scalar_value[offset])
        stack_top = summary.register('rsp')
        stack_floor = stack_top & ~0xfff
        ignored = {
            translate(summary, address)
            for address in range(stack_floor, stack_top)
        }
        ignored.update(
            translate(summary, address)
            for address in range(buffer + extent, buffered)
        )
        live_memory_bytes = tuple(
            item for item in all_bytes if item[0] not in ignored)
        print('live_memory_bytes=%r' % (live_memory_bytes[:64],))

    callee_saved = ('rbx', 'rsp', 'rbp', 'r12', 'r13', 'r14', 'r15')
    live_registers_equal = all(
        summary.register(name) == scalar.register(name)
        for name in callee_saved)
    live_fields_equal = all(
        getattr(summary, name) == getattr(scalar, name)
        for name in (
            'rip', 'cr0', 'cr2', 'cr3', 'cr4', 'cr8', 'efer',
            'gdtr', 'idtr', 'cs', 'ds', 'es', 'ss', 'fs', 'gs',
            'ldtr', 'tr', 'debug', 'msrs', 'halted', 'interrupts'))
    quotient_equal = (
        live_registers_equal and live_fields_equal
        and not live_memory_bytes and scalar_clocks == extra_clocks)
    print('quotient_equal=%r' % quotient_equal)
    return int(not quotient_equal)


if __name__ == '__main__':
    raise SystemExit(main())
