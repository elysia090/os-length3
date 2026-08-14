#!/usr/bin/env python3
"""Locate the first state divergence between the oracle and vm.wasm x86.

Python is a build/test oracle here.  The measured runtime is the native
artifact executed by vm.wasm; every completed physical block emits a read-only
state sample for this audit.  A mismatch fails instead of selecting a host
execution fallback.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.machine import MachineEvent
from kernel.x86 import X86DBT, X86Machine
from kernel.x86snapshot import (load_native_x86_machine,
                                load_x86_boot_cache, NATIVE_BLOCK_HEADER)
from tools.build_native_x86_machine import _open_boot
from tools.close_native_x86_runtime import load_runtime_cut


MASK64 = (1 << 64) - 1

_NATIVE_CONTROLS = {
    0: 'next', 1: 'branch', 2: 'conditional', 3: 'dynamic',
    4: 'halt', 5: 'timeslice', 6: 'write-msr', 7: 'read-msr',
    8: 'cpuid', 9: 'register', 10: 'segment', 11: 'descriptor',
    12: 'far-return', 13: 'divide', 14: 'interrupt-return',
    15: 'internal', 16: 'read-segment', 17: 'port-read',
    18: 'port-write', 19: 'invalidate-page', 20: 'clock',
}


def _word(value):
    return '%016x' % (int(value) & MASK64)


def _native_control_owners(path):
    """Index resident control ownership without executing or decoding SSA."""
    _header, _memory, records = load_native_x86_machine(
        Path(path).read_bytes())
    controls = {}
    for rip, record in records:
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        control = int(fields[6])
        controls[_word(rip)] = {
            'control': control,
            'operation': _NATIVE_CONTROLS.get(control, 'unknown'),
            'owner': ('resident-device' if control in (17, 18)
                      else 'external-barrier' if control == 20
                      else 'resident-vm'),
        }
    return controls


def _expected(state):
    cpu = state.cpu
    return {
        'rip': _word(cpu.rip),
        'rflags': _word(cpu.rflags),
        'registers': [_word(value) for value in cpu.registers],
    }


def _samples(node, runner, native, wasm, blocks, resume=None):
    environment = os.environ.copy()
    environment['QM_X86_STATE_TRACE'] = '1'
    command = (str(node), str(runner), str(native), str(wasm), str(blocks))
    if resume is not None:
        command += ('-', str(resume))
    completed = subprocess.run(
        command,
        cwd=REPOSITORY, env=environment, capture_output=True, text=True,
        encoding='utf-8', errors='replace', check=False)
    samples = []
    for line in completed.stderr.splitlines():
        if line.startswith('@state '):
            samples.append(json.loads(line[len('@state '):]))
    try:
        terminal = json.loads(completed.stdout)
    except json.JSONDecodeError:
        terminal = None
    if completed.returncode or terminal is None:
        raise RuntimeError(json.dumps({
            'node_exit': completed.returncode,
            'expected_samples': blocks,
            'samples': len(samples),
            'stdout_tail': completed.stdout.splitlines()[-12:],
            'stderr_tail': completed.stderr.splitlines()[-12:],
        }, indent=2))
    return samples, terminal


def audit(node, runner, native, wasm, artifact_root, source, blocks,
          alignment_window=16, resume=None):
    samples, observed_terminal = _samples(
        node, runner, native, wasm, blocks, resume)
    control_owners = _native_control_owners(native)
    runtime = X86Machine(X86DBT(profile_controls=True))
    if resume is None:
        boot_payload, identity = _open_boot(artifact_root, source)
        boot = load_x86_boot_cache(boot_payload)
        oracle_state = runtime.start(boot.state)
    else:
        oracle_state, identity, _dirty_pages = load_runtime_cut(
            artifact_root, source, Path(resume))
    expected_samples = []

    def ensure_expected(count):
        nonlocal oracle_state
        while len(expected_samples) < count:
            oracle_state, event = runtime.machine_step(
                oracle_state, budget=1, max_internal=1, clock_step=1)
            while event is not None and event.operation in (
                    'console_write', 'entropy', 'interrupt'):
                response = None
                if event.operation == 'entropy':
                    value = ((oracle_state.cpu.rip
                              * 0x9e3779b97f4a7c15
                              + 0xd1b54a32d192ed03) & MASK64)
                    response = MachineEvent(
                        'entropy', event.coordinate, value)
                elif event.operation == 'interrupt':
                    response = MachineEvent(
                        'interrupt', event.coordinate)
                oracle_state, event = runtime.machine_step(
                    oracle_state, response, budget=1,
                    max_internal=1, clock_step=1)
            expected_samples.append((_expected(oracle_state), event))

    def actual_state(observed):
        return {name: observed[name]
                for name in ('rip', 'rflags', 'registers')}

    actual_index = 0
    expected_index = 0
    actual_extra_cuts = 0
    oracle_extra_cuts = 0
    alignment_points = 0
    window = max(1, int(alignment_window))
    # vm.wasm may publish a completed internal admission/delivery turn before
    # retiring source code (notably when a pending interrupt is admitted from
    # a resumed cut).  It is an extra physical cut, not an architectural
    # mismatch, when the complete state is still the saved initial state.
    initial = _expected(oracle_state)
    while (actual_index < len(samples)
           and actual_state(samples[actual_index]) == initial):
        actual_index += 1
        actual_extra_cuts += 1
        alignment_points += 1
    while actual_index < len(samples):
        # A long run can accumulate many local cut-grouping differences. Keep
        # the lookahead bounded at each comparison without bounding total skew.
        ensure_expected(expected_index + window + 1)
        actual = actual_state(samples[actual_index])
        expected, event = expected_samples[expected_index]
        if actual != expected:
            expected_ahead = next((offset for offset in range(1, window + 1)
                if expected_index + offset < len(expected_samples)
                and expected_samples[expected_index + offset][0] == actual),
                None)
            actual_ahead = next((offset for offset in range(1, window + 1)
                if actual_index + offset < len(samples)
                and actual_state(samples[actual_index + offset]) == expected),
                None)
            if expected_ahead is not None and (actual_ahead is None
                    or expected_ahead <= actual_ahead):
                expected_index += expected_ahead
                oracle_extra_cuts += expected_ahead
                alignment_points += 1
                expected, event = expected_samples[expected_index]
            elif actual_ahead is not None:
                actual_index += actual_ahead
                actual_extra_cuts += actual_ahead
                alignment_points += 1
                actual = actual_state(samples[actual_index])
            else:
                index = actual_index + 1
                predecessor = (samples[actual_index - 1]
                               if actual_index else None)
                predecessor_rip = (None if predecessor is None
                                   else predecessor['rip'])
                register_differences = []
                for register, (left, right) in enumerate(zip(
                        expected['registers'], actual['registers'])):
                    if left != right:
                        register_differences.append({
                            'register': register,
                            'expected': left,
                            'actual': right,
                        })
                return {
                    'ok': False,
                    'parity_ok': False,
                    'source_identity': identity,
                    'block': index,
                    'oracle_cut': expected_index + 1,
                    'event': None if event is None else event.operation,
                    'predecessor_rip': predecessor_rip,
                    'predecessor_owner': control_owners.get(predecessor_rip),
                    'expected': expected,
                    'actual': actual,
                    'register_differences': register_differences,
                    'alignment_window': window,
                    'actual_extra_cuts': actual_extra_cuts,
                    'oracle_extra_cuts': oracle_extra_cuts,
                }
        if actual != expected:
            register_differences = []
            for register, (left, right) in enumerate(zip(
                    expected['registers'], actual['registers'])):
                if left != right:
                    register_differences.append({
                        'register': register,
                        'expected': left,
                        'actual': right,
                    })
            raise AssertionError(register_differences)
        actual_index += 1
        expected_index += 1
    coverage_complete = len(samples) == blocks
    aligned_terminal = (expected_samples[expected_index - 1][0]
                        if expected_index else _expected(oracle_state))
    return {
        'ok': coverage_complete,
        'parity_ok': True,
        'coverage_complete': coverage_complete,
        'source_identity': identity,
        'requested_blocks': blocks,
        'compared_blocks': len(samples),
        'compared_oracle_cuts': expected_index,
        'alignment_points': alignment_points,
        'actual_extra_cuts': actual_extra_cuts,
        'oracle_extra_cuts': oracle_extra_cuts,
        'missing_block': observed_terminal.get('missing_block'),
        'terminal': aligned_terminal,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--runner', type=Path,
                        default=ROOT / 'tools' / 'run_native_x86_machine.mjs')
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--wasm', type=Path, default=ROOT / 'web' / 'vm.wasm')
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    parser.add_argument('--blocks', type=int, default=1200)
    parser.add_argument('--resume', type=Path,
                        help='compare from this saved architectural cut')
    parser.add_argument('--alignment-window', type=int, default=16)
    arguments = parser.parse_args(argv)
    if arguments.blocks <= 0:
        parser.error('--blocks must be positive')
    result = audit(
        arguments.node.resolve(), arguments.runner.resolve(),
        arguments.native.resolve(), arguments.wasm.resolve(),
        arguments.artifact_root.resolve(), arguments.source,
        arguments.blocks, arguments.alignment_window, arguments.resume)
    print(json.dumps(result, indent=2, sort_keys=True))
    return int(not result['ok'])


if __name__ == '__main__':
    raise SystemExit(main())
