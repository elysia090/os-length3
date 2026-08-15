#!/usr/bin/env python3
"""Differential fuzzing for composed x86 block quotients.

The ordinary frontend fuzzer checks one pure expression.  This harness checks
the larger unit which the native runtime actually executes: a decoded block
graph after stack, predicate, memory, register, and control composition.  Each
optimized physical cut is compared with the same number of source
instructions executed through uncomposed decoded cuts.  The native record is
also packed on every case, so a result which cannot cross the artifact codec
is a failure rather than an untested fallback.

Failures print a deterministic seed, case number, complete machine code, and
initial architectural state.  One invocation is therefore a pasteable corpus
reproducer.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import random
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86 import (MASK64, X86DBT, _block_source_instructions,
                        initial_state)
from kernel.x86snapshot import (pack_native_x86_records,
                                split_native_x86_record)
from qm.steppage import unpack as unpack_step
from qm.stepnormalize import physical_work
from qm.wasmstate import PagedMemory


CODE = 0x100
DATA = 0x400
STACK = 0x900
MEMORY_BYTES = 0x10000


# Every member is one complete, non-control instruction.  Addresses use RBX,
# which is pinned to the writable data row.  Stack operations are balanced by
# construction so they can be freely mixed with an enclosing call fixture.
_STRAIGHT = (
    bytes.fromhex('83 c0 01'),              # add eax, 1
    bytes.fromhex('83 e8 03'),              # sub eax, 3
    bytes.fromhex('35 5a a5 5a a5'),        # xor eax, 0xa55aa55a
    bytes.fromhex('25 ff 0f ff 7f'),        # and eax, 0x7fff0fff
    bytes.fromhex('0d 00 80 00 80'),        # or eax, 0x80008000
    bytes.fromhex('6b c0 07'),              # imul eax, eax, 7
    bytes.fromhex('c1 e0 03'),              # shl eax, 3
    bytes.fromhex('c1 e8 05'),              # shr eax, 5
    bytes.fromhex('c1 f8 07'),              # sar eax, 7
    bytes.fromhex('89 c2'),                 # mov edx, eax
    bytes.fromhex('01 ca'),                 # add edx, ecx
    bytes.fromhex('29 c8'),                 # sub eax, ecx
    bytes.fromhex('31 d0'),                 # xor eax, edx
    bytes.fromhex('85 c0'),                 # test eax, eax
    bytes.fromhex('83 f8 11'),              # cmp eax, 17
    bytes.fromhex('0f 94 c2'),              # sete dl
    bytes.fromhex('0f 45 c1'),              # cmovne eax, ecx
    bytes.fromhex('8b 03'),                 # mov eax, [rbx]
    bytes.fromhex('8b 4b 08'),              # mov ecx, [rbx+8]
    bytes.fromhex('89 43 10'),              # mov [rbx+16], eax
    bytes.fromhex('89 53 18'),              # mov [rbx+24], edx
    bytes.fromhex('83 43 20 01'),           # add dword [rbx+32], 1
    bytes.fromhex('31 43 28'),              # xor [rbx+40], eax
    bytes.fromhex('49 8b 02'),              # mov rax, [r10]
    bytes.fromhex('49 89 42 08'),           # mov [r10+8], rax
    bytes.fromhex('49 87 42 10'),           # xchg [r10+16], rax
    bytes.fromhex('f0 49 01 42 18'),        # lock add [r10+24], rax
    bytes.fromhex('f0 49 0f b1 4a 20'),     # lock cmpxchg [r10+32], rcx
    bytes.fromhex('66 0f ef c0'),           # pxor xmm0, xmm0
    bytes.fromhex('66 0f ef c9'),           # pxor xmm1, xmm1
    bytes.fromhex('41 0f 10 02'),           # movups xmm0, [r10]
    bytes.fromhex('41 0f 11 42 30'),        # movups [r10+48], xmm0
    bytes.fromhex('66 0f 6f c8'),           # movdqa xmm1, xmm0
    bytes.fromhex('50 58'),                 # push rax; pop rax
    bytes.fromhex('51 5a'),                 # push rcx; pop rdx
    bytes.fromhex('fc'),                    # cld
    bytes.fromhex('fd'),                    # std
    bytes.fromhex('fa'),                    # cli
)


_FIXED = (
    # Flag producers and consumers spanning several decoded boundaries.
    bytes.fromhex('83 c0 01 85 c0 0f 94 c2 83 e8 01 0f 45 c1 f4'),
    # A store, pointer-independent work, and an exact same-coordinate load.
    bytes.fromhex('89 43 10 83 c1 07 8b 53 10 01 d0 f4'),
    # Enabling IF followed by the architecturally shadowed instruction.  The
    # quotient may join them, but their state must equal two scalar steps.
    bytes.fromhex('fb e9 00 00 00 00 83 c0 01 f4'),
    # musl malloc's unlink shape: repeated same-coordinate loads separated by
    # stores.  It catches memory-token rewrites which look equivalent only
    # after incorrectly materializing the first loaded pointer.
    bytes.fromhex(
        '49 8b 12 48 89 42 08 49 8b 12 48 89 10 4d 39 d2 f4'),
    # Vector clear/store used by nontrivial_free.  XMM state is part of the
    # architectural signature; omitting it lets a bad scalar fallback hide.
    bytes.fromhex('66 0f ef c0 41 0f 11 42 30 41 0f 10 4a 30 f4'),
    # Atomic allocator update.  The quotient must preserve both the old RAX
    # value and the exact memory/flags publication of CMPXCHG.
    bytes.fromhex('f0 49 0f b1 4a 20 0f 94 c2 f4'),
    # Linux context switches exercise these as ordinary resident state steps.
    bytes.fromhex('0f ae 03 f4'),            # fxsave [rbx]
    bytes.fromhex('0f ae 0b f4'),            # fxrstor [rbx]
)


def _random_instruction(rng: random.Random) -> bytes:
    return rng.choice(_STRAIGHT)


def _random_body(rng: random.Random, count: int) -> bytes:
    return b''.join(_random_instruction(rng) for _ in range(count))


def generated_program(rng: random.Random, max_ops: int) -> bytes:
    """Build one bounded forward block graph with an optional call edge."""
    count = rng.randint(1, max(1, int(max_ops)))
    body = bytearray()
    for _unused in range(count):
        family = rng.randrange(10)
        if family < 7:
            body += _random_instruction(rng)
        elif family < 9:
            skipped = _random_instruction(rng)
            if len(skipped) > 0x7f:
                raise AssertionError('fuzz instruction exceeds rel8')
            body += bytes.fromhex('85 c0')
            body += bytes((0x74 if rng.randrange(2) else 0x75,
                           len(skipped)))
            body += skipped
        else:
            skipped = _random_instruction(rng)
            body += bytes((0xeb, len(skipped))) + skipped

    if rng.randrange(4):
        return bytes(body) + b'\xf4'

    # Exercise sparse call/return composition.  The leaf is placed after the
    # caller's HLT, so the physical proof has two exact code extents instead
    # of materializing the cold address gap.
    prefix = bytes(body)
    following = CODE + len(prefix) + 5
    leaf = _random_body(rng, rng.randint(1, 4)) + b'\xc3'
    leaf_address = following + 1
    relative = leaf_address - following
    return (prefix + b'\xe8' + int(relative).to_bytes(
        4, 'little', signed=True) + b'\xf4' + leaf)


def _memory(code: bytes, data: bytes) -> PagedMemory:
    memory = PagedMemory(b'', 65536)
    memory = memory.write(CODE, code)
    memory = memory.write(DATA, data)
    memory = memory.write(STACK - 0x100, bytes(0x100))
    return memory


def _state_signature(state):
    return {
        'rip': '%016x' % (int(state.rip) & MASK64),
        'rflags': '%016x' % (int(state.rflags) & MASK64),
        'registers': ['%016x' % (int(value) & MASK64)
                      for value in state.registers],
        'xmm': ['%016x' % (int(value) & MASK64)
                for value in state.xmm],
        'halted': bool(state.halted),
        'control': [
            '%016x' % (int(state.cr0) & MASK64),
            '%016x' % (int(state.cr2) & MASK64),
            '%016x' % (int(state.cr3) & MASK64),
            '%016x' % (int(state.cr4) & MASK64),
            '%016x' % (int(state.cr8) & MASK64),
            '%016x' % (int(state.efer) & MASK64),
        ],
        'segments': [int(state.es), int(state.cs), int(state.ss),
                     int(state.ds), int(state.fs), int(state.gs)],
    }


def _boundary_signature(boundary):
    if boundary is None:
        return None
    return boundary.operation, repr(boundary.detail)


def _word(value):
    return '%016x' % (int(value) & MASK64)


def check_case(code: bytes, registers: dict[str, int], rflags: int,
               include_vm_fixture=False):
    """Compare one optimized cut with its exact scalar retirement prefix."""
    rng_data = bytes(registers.pop('_data'))
    xmm = tuple(registers.pop('_xmm'))
    initial_memory = _memory(code, rng_data)
    initial = initial_state(
        initial_memory, CODE, registers, rflags=int(rflags), xmm=xmm)
    optimized = X86DBT(enable_function_oracles=False)
    physical = optimized.physical_block(initial)
    records = pack_native_x86_records(physical)
    if not records:
        raise AssertionError('physical block produced no native record')
    fast, fast_boundary, fast_cost = optimized.step(
        initial, max_controls=1)
    # The portable records carry the exact source retirement used by vm.wasm.
    # Faultable terminal operations can be split into an internal prefix and
    # retry record, so sum their two STEP counts.
    recorded_retirement = sum(
        unpack_step(split_native_x86_record(record)[2]).instructions
        for _coordinate, record in records)
    if recorded_retirement <= 0:
        raise AssertionError('physical block retired no source instruction')

    scalar = X86DBT(enable_function_oracles=False)
    scalar.physical_block = lambda state: scalar.block(state)
    scalar._collapse_branch = lambda state, _block: state
    scalar._collapse_direct_branch = lambda state, _block: state
    slow = initial
    slow_boundary = None
    scalar_retired = 0
    frontier = None
    fast_boundary_signature = _boundary_signature(fast_boundary)
    for _unused in range(256):
        decoded = scalar.block(slow)
        # A decoded scalar block counts its pure prefix; its terminal x86
        # instruction is the published boundary and retires once as well.
        scalar_retired += _block_source_instructions(decoded)
        slow, slow_boundary, _cost = scalar.step(slow, max_controls=1)
        if (slow.rip == fast.rip and slow.halted == fast.halted
                and _boundary_signature(slow_boundary)
                == fast_boundary_signature):
            frontier = slow
            break
        if slow_boundary is not None:
            break
    if frontier is None:
        raise AssertionError(
            'physical endpoint %#x/%r is not a scalar frontier after %d '
            'source instructions'
            % (fast.rip, fast_boundary_signature, scalar_retired))

    expected = _state_signature(slow)
    actual = _state_signature(fast)
    expected_memory = slow.memory.read(0, MEMORY_BYTES)
    actual_memory = fast.memory.read(0, MEMORY_BYTES)
    expected_boundary = _boundary_signature(slow_boundary)
    actual_boundary = _boundary_signature(fast_boundary)
    if (expected != actual or expected_memory != actual_memory
            or expected_boundary != actual_boundary):
        memory_difference = next((index for index, pair in enumerate(zip(
            expected_memory, actual_memory)) if pair[0] != pair[1]), None)
        raise AssertionError(json.dumps({
            'recorded_retirement': recorded_retirement,
            'scalar_retirement': scalar_retired,
            'expected_boundary': expected_boundary,
            'actual_boundary': actual_boundary,
            'first_memory_difference': memory_difference,
            'expected_memory': (None if memory_difference is None else
                                expected_memory[
                                    memory_difference:memory_difference + 32
                                ].hex()),
            'actual_memory': (None if memory_difference is None else
                              actual_memory[
                                  memory_difference:memory_difference + 32
                              ].hex()),
            'expected': expected,
            'actual': actual,
        }, indent=2)[:16000])
    result = {
        'retired': scalar_retired,
        'recorded_retirement': recorded_retirement,
        'retirement_delta': recorded_retirement - scalar_retired,
        'work': physical_work(physical.plan),
        'span': physical.plan.waves.span,
        'records': len(records),
    }
    if include_vm_fixture:
        encoded = lambda payload: base64.b64encode(bytes(payload)).decode()
        ranges = ((CODE, max(0x100, len(code))),
                  (DATA, 0x300), (STACK - 0x100, 0x200))
        result['vm_fixture'] = {
            'records': [[_word(coordinate), encoded(record)]
                        for coordinate, record in records],
            'state': {
                'registers': [_word(value) for value in initial.registers],
                'xmm': [_word(value) for value in initial.xmm],
                'rip': _word(initial.rip),
                'rflags': _word(initial.rflags),
            },
            'memory': [[offset, encoded(initial_memory.read(offset, length))]
                       for offset, length in ranges],
            'expected': {
                'registers': [_word(value) for value in fast.registers],
                'xmm': [_word(value) for value in fast.xmm],
                'rip': _word(fast.rip),
                'rflags': _word(fast.rflags),
                'halted': bool(fast.halted),
                'memory': [[offset, encoded(fast.memory.read(offset, length))]
                           for offset, length in ranges],
            },
        }
    return result


def fuzz(cases: int, seed: int, max_ops: int = 24, vm_wasm=None,
         node='node'):
    rng = random.Random(int(seed))
    total_retired = 0
    total_work = 0
    total_span = 0
    max_retired = 0
    retirement_mismatches = 0
    retirement_delta = 0
    completed = 0
    vm_fixtures = []
    programs = list(_FIXED)
    programs.extend(generated_program(rng, max_ops)
                    for _unused in range(max(0, int(cases) - len(programs))) )
    for case, code in enumerate(programs[:int(cases)]):
        data = bytearray(rng.getrandbits(8) for _ in range(0x100))
        data[0x30:0x38] = int(DATA + 0x90).to_bytes(8, 'little')
        registers = {
            'rax': DATA + 0xa0,
            'rcx': rng.getrandbits(64),
            'rdx': rng.getrandbits(64),
            'rbx': DATA,
            'rsi': DATA + 0x40,
            'rdi': DATA + 0x80,
            'rsp': STACK,
            'rbp': DATA + 0xc0,
            'r8': DATA + 0x10,
            'r9': DATA + 0x20,
            'r10': DATA + 0x30,
            'r11': DATA + 0x40,
            'r12': DATA + 0x50,
            'r13': DATA + 0x60,
            'r14': DATA + 0x70,
            'r15': DATA + 0x80,
            '_xmm': tuple(rng.getrandbits(64) for _ in range(32)),
            '_data': bytes(data),
        }
        rflags = (rng.getrandbits(12) | 2) & ~(1 << 10)
        reproduction = {
            'seed': int(seed), 'case': case, 'code': code.hex(),
            'registers': {
                name: ('%016x' % value if isinstance(value, int)
                       else value.hex() if isinstance(value, bytes)
                       else ['%016x' % item for item in value])
                for name, value in registers.items()
            },
            'rflags': '%016x' % rflags,
        }
        try:
            result = check_case(
                code, dict(registers), rflags,
                include_vm_fixture=vm_wasm is not None)
        except Exception as error:
            print(json.dumps(reproduction, indent=2))
            raise AssertionError(
                'x86 block quotient fuzz failure: %s' % error) from error
        completed += 1
        total_retired += result['retired']
        total_work += result['work']
        total_span += result['span']
        max_retired = max(max_retired, result['retired'])
        retirement_mismatches += int(bool(result['retirement_delta']))
        retirement_delta += result['retirement_delta']
        if vm_wasm is not None:
            fixture = result['vm_fixture']
            fixture['case'] = case
            vm_fixtures.append(fixture)
    vm_result = None
    if vm_wasm is not None:
        runner = Path(__file__).with_name('fuzz_x86_vm.mjs')
        run = subprocess.run(
            [str(node), str(runner), str(Path(vm_wasm).resolve())],
            input=json.dumps({'memory_bytes': MEMORY_BYTES,
                              'cases': vm_fixtures}),
            check=False, capture_output=True, text=True,
            encoding='utf-8', errors='replace')
        if run.returncode:
            raise AssertionError(
                'vm.wasm x86 quotient fuzz failed: %s'
                % (run.stderr.strip() or run.stdout.strip()))
        vm_result = json.loads(run.stdout)
        if vm_result.get('mismatch') is not None:
            raise AssertionError(json.dumps(vm_result, indent=2)[:16000])
    return {
        'cases': completed,
        'seed': int(seed),
        'source_instructions': total_retired,
        'physical_work': total_work,
        'physical_span': total_span,
        'source_per_work': (total_retired / total_work
                            if total_work else None),
        'max_block_instructions': max_retired,
        'retirement_mismatches': retirement_mismatches,
        'retirement_delta': retirement_delta,
        'vm_cases': None if vm_result is None else vm_result['cases'],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases', type=int, default=1000)
    parser.add_argument('--seed', type=int, default=0xB10C)
    parser.add_argument('--max-ops', type=int, default=24)
    parser.add_argument('--vm-wasm', type=Path,
                        help='also compare every cut with this resident VM')
    parser.add_argument('--node', default='node',
                        help='Node.js executable used by --vm-wasm')
    arguments = parser.parse_args(argv)
    if arguments.cases < 1 or arguments.max_ops < 1:
        parser.error('cases and max-ops must be positive')
    print(json.dumps(fuzz(
        arguments.cases, arguments.seed, arguments.max_ops,
        arguments.vm_wasm, arguments.node),
        indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
