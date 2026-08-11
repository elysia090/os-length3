"""Locate the first x86 semantic divergence while expanding a bzImage.

The compressed payload is expanded by the host gzip implementation and used
only as an independent byte oracle.  The same image is then entered through
the direct 64-bit Linux boot protocol and run until the decompressor halts.
Comparing physical memory a page at a time avoids materializing a second guest
RAM image and reports the smallest useful coordinate for a focused trace.
"""

import argparse
import base64
from dataclasses import replace
import gzip
import json
from pathlib import Path
import struct
import subprocess
from time import perf_counter

from kernel.machine import MachineEvent
from kernel.x86 import (MASK32, REGISTER_INDEX, X86Boundary, X86DBT,
                        IA32_TIME_STAMP_COUNTER, X86Machine, load_bzimage,
                        load_bzimage_kernel, advance_virtual_clock)
from kernel.x86snapshot import (dump_x86_machine_state,
                                load_x86_machine_state)
from qm.memorycut import MemoryCut


def compressed_payload(image):
    setup_bytes = ((image[0x1f1] or 4) + 1) * 512
    offset = int.from_bytes(image[0x248:0x24c], 'little')
    length = int.from_bytes(image[0x24c:0x250], 'little')
    start = setup_bytes + offset
    end = start + length
    if not length or end > len(image):
        raise ValueError('bzImage compressed-payload extent is invalid')
    return image[start:end]


def run_to_halt(image, memory_bytes, budget, max_machine_steps=None,
                progress=False, kernel_entry=False, initrd=None,
                command_line=None, checkpoint=None, resume=None,
                checkpoint_interval=256, clock_step=1 << 20,
                clock_variation_bits=12, profile_controls=False,
                max_internal=1024, sponge_records=None):
    loader = load_bzimage_kernel if kernel_entry else load_bzimage
    boot = loader(image, memory_bytes=memory_bytes, initrd=initrd,
                  command_line=command_line)
    runtime = X86Machine(X86DBT(
        profile_controls=profile_controls,
        sponge_records=sponge_records))
    state = (runtime.start(boot.state) if resume is None else
             load_x86_machine_state(resume, boot.state.memory))
    clock_value = dict(state.cpu.msrs).get(IA32_TIME_STAMP_COUNTER, 0)
    entropy_value = (clock_value ^ 0x9e3779b97f4a7c15) \
        & ((1 << 64) - 1)
    response = None
    if state.pending is not None:
        if state.pending.operation == 'clock':
            clock_value = advance_virtual_clock(
                clock_value, clock_step, clock_variation_bits)
            response = MachineEvent(
                'clock', state.pending.coordinate, clock_value)
        elif state.pending.operation == 'entropy':
            entropy_value = (entropy_value * 6364136223846793005 + 1) \
                & ((1 << 64) - 1)
            response = MachineEvent(
                'entropy', state.pending.coordinate, entropy_value)
        elif state.pending.operation == 'interrupt':
            response = MachineEvent('interrupt', state.pending.coordinate)
        else:
            raise RuntimeError(
                'checkpoint awaits unsupported machine event %s'
                % state.pending.operation)
    console = bytearray()
    calls = 0
    while not state.stopped:
        step_started = perf_counter()
        state, event = runtime.machine_step(
            state, response, budget=budget, clock_step=clock_step,
            clock_variation_bits=clock_variation_bits,
            max_internal=max_internal)
        step_seconds = perf_counter() - step_started
        response = None
        calls += 1
        if progress:
            event_name = (None if event is None else
                          getattr(event, 'operation', type(event).__name__))
            print('progress=%d event=%s rip=0x%x r10=0x%x '
                  'step_seconds=%.6f '
                  'affine_clock_events=%d layout=%r'
                  % (calls, event_name, state.cpu.rip,
                     state.cpu.register('r10'), step_seconds,
                     runtime.affine_clock_events,
                     runtime.dbt.layout()), flush=True)
        checkpoint_due = (checkpoint is not None
                          and (calls % max(1, int(checkpoint_interval)) == 0
                               or isinstance(event, X86Boundary)
                               or state.stopped
                               or (max_machine_steps is not None
                                   and calls >= max_machine_steps)))
        if checkpoint_due:
            temporary = checkpoint.with_name(checkpoint.name + '.tmp')
            temporary.write_bytes(dump_x86_machine_state(
                state, boot.state.memory))
            temporary.replace(checkpoint)
        if max_machine_steps is not None and calls >= max_machine_steps:
            if (event is not None
                    and not isinstance(event, X86Boundary)
                    and event.operation == 'console_write'):
                console.extend(event.data)
            break
        if event is None:
            continue
        if isinstance(event, X86Boundary):
            raise RuntimeError(
                'unsupported x86 boundary %s: %r'
                % (event.operation, event.detail))
        if event.operation == 'console_write':
            console.extend(event.data)
        elif event.operation == 'clock':
            clock_value = advance_virtual_clock(
                clock_value, clock_step, clock_variation_bits)
            response = MachineEvent(
                'clock', event.coordinate, clock_value)
        elif event.operation == 'entropy':
            entropy_value = (entropy_value * 6364136223846793005 + 1) \
                & ((1 << 64) - 1)
            response = MachineEvent(
                'entropy', event.coordinate, entropy_value)
        elif event.operation == 'interrupt':
            response = MachineEvent('interrupt', event.coordinate)
        else:
            raise RuntimeError(
                'unsupported machine event %s' % event.operation)
    return boot, state.cpu, runtime.dbt, bytes(console), calls


def first_mismatch(memory, address, expected, chunk_bytes=4096):
    for base in range(0, len(expected), chunk_bytes):
        reference = expected[base:base + chunk_bytes]
        actual = memory.read(address + base, len(reference))
        if actual != reference:
            for inner, (wanted, found) in enumerate(zip(reference, actual)):
                if wanted != found:
                    return base + inner, wanted, found
    return None


def _register_window(state):
    names = ('rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi',
             'r8', 'r10', 'r12', 'r14', 'r15')
    return ' '.join('%s=%x' % (name, state.register(name)) for name in names)


def trace_changes(image, address, width, memory_bytes, max_steps=1 << 20,
                  follow_after_changes=0, follow_start=0,
                  follow_stop=None):
    """Report only blocks that change one small physical window."""
    boot = load_bzimage(image, memory_bytes=memory_bytes)
    state = replace(boot.state, memory=MemoryCut(boot.state.memory))
    dbt = X86DBT()
    previous = state.memory.read(address, width)
    changes = 0
    print('trace_initial=%s' % previous.hex())
    for sequence in range(max_steps):
        rip = state.rip
        prior = state
        state, boundary, _cost = dbt.run(
            state, budget=1 << 30, max_blocks=1)
        current = state.memory.read(address, width)
        if current != previous:
            block = dbt.blocks.get(rip)
            changes += 1
            print('trace_change=%d rip=0x%x source=%s control=%r before=%s after=%s flags=%x %s'
                  % (sequence, rip,
                     '' if block is None else block.source.hex(),
                     None if block is None else block.boundary,
                     previous.hex(), current.hex(), prior.rflags,
                     _register_window(prior)))
            previous = current
        block = dbt.blocks.get(rip)
        if (follow_after_changes and changes >= follow_after_changes
                and sequence >= follow_start
                and (follow_stop is None or sequence < follow_stop)):
            print('trace_follow=%d rip=0x%x source=%s control=%r flags=%x %s'
                  % (sequence, rip,
                     '' if block is None else block.source.hex(),
                     None if block is None else block.boundary,
                     prior.rflags, _register_window(prior)))
        if boundary.operation == 'halt':
            print('trace_halt=%d rip=0x%x' % (sequence, state.rip))
            return
        if boundary.operation == 'clock':
            following = int(boundary.detail)
            registers = list(state.registers)
            registers[REGISTER_INDEX['rax']] = 0 & MASK32
            registers[REGISTER_INDEX['rdx']] = 0
            state = replace(state, registers=tuple(registers), rip=following)
        elif boundary.operation not in ('timeslice', 'port_write'):
            raise RuntimeError(
                'trace stopped at %s: %r'
                % (boundary.operation, boundary.detail))
    raise RuntimeError('trace step limit reached')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('bzimage', type=Path)
    parser.add_argument('--memory-mib', type=int, default=128)
    parser.add_argument('--budget', type=int, default=1 << 22)
    parser.add_argument('--trace-mismatch', action='store_true')
    parser.add_argument('--follow-after-changes', type=int, default=0)
    parser.add_argument('--follow-start', type=int, default=0)
    parser.add_argument('--follow-stop', type=int)
    parser.add_argument('--max-machine-steps', type=int)
    parser.add_argument('--progress', action='store_true')
    parser.add_argument('--kernel-entry', action='store_true')
    parser.add_argument('--initrd', type=Path)
    parser.add_argument('--command-line')
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--resume-checkpoint', type=Path)
    parser.add_argument('--checkpoint-interval', type=int, default=256)
    parser.add_argument('--clock-step', type=int, default=1 << 20)
    parser.add_argument('--clock-variation-bits', type=int, default=12)
    parser.add_argument('--profile-controls', action='store_true')
    parser.add_argument('--max-internal', type=int, default=1024)
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
                'records': base64.b64encode(
                    packed_records).decode('ascii'),
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
    expected = gzip.decompress(compressed_payload(image))
    boot, cpu, dbt, console, calls = run_to_halt(
        image, arguments.memory_mib << 20, arguments.budget,
        arguments.max_machine_steps, arguments.progress,
        arguments.kernel_entry,
        None if arguments.initrd is None else arguments.initrd.read_bytes(),
        arguments.command_line,
        arguments.checkpoint,
        None if arguments.resume_checkpoint is None else
        arguments.resume_checkpoint.read_bytes(),
        arguments.checkpoint_interval,
        arguments.clock_step,
        arguments.clock_variation_bits,
        arguments.profile_controls,
        arguments.max_internal,
        sponge_records)
    mismatch = first_mismatch(cpu.memory, boot.load_address, expected)

    print('expected_bytes=%d' % len(expected))
    print('load_address=0x%x' % boot.load_address)
    print('machine_steps=%d' % calls)
    print('stopped=%r' % cpu.halted)
    print('console=%r' % console[-512:])
    print('layout=%r' % dbt.layout())
    if arguments.kernel_entry:
        return 0 if cpu.halted else 1
    if mismatch is None:
        print('first_mismatch=none')
        return 0
    offset, wanted, found = mismatch
    start = max(0, offset - 16)
    end = min(len(expected), offset + 17)
    actual = cpu.memory.read(boot.load_address + start, end - start)
    print('first_mismatch=0x%x physical=0x%x expected=%02x actual=%02x'
          % (offset, boot.load_address + offset, wanted, found))
    print('expected_window=%s' % expected[start:end].hex())
    print('actual_window=%s' % actual.hex())
    if arguments.trace_mismatch:
        trace_start = boot.load_address + max(0, offset - 8)
        trace_changes(image, trace_start, 24,
                      arguments.memory_mib << 20,
                      follow_after_changes=arguments.follow_after_changes,
                      follow_start=arguments.follow_start,
                      follow_stop=arguments.follow_stop)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
