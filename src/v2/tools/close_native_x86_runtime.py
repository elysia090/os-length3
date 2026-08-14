#!/usr/bin/env python3
"""Extend a native x86 artifact from an exact vm.wasm missing-block cut.

This is a build/oracle tool.  The snapshot is produced by vm.wasm and carries
only architectural state plus dirty physical pages.  No Python interpreter is
introduced into the browser runtime path.
"""

import argparse
import base64
from collections import Counter
from dataclasses import replace
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.machine import MachineEvent
from kernel.x86 import PageFault, X86DBT, X86Machine, X86MachineState
from kernel.x86snapshot import (canonical_native_x86_records,
                                extend_loaded_native_x86_physical_machine,
                                load_native_x86_physical_machine,
                                load_x86_boot_cache,
                                native_x86_cut_coordinates,
                                native_x86_static_successors,
                                pack_native_x86_records,
                                physical_native_x86_record,
                                select_physical_cut)
from qm.steppage import StatePageError
from tools.build_native_x86_machine import _open_boot


def _word(value):
    return int(str(value), 16)


def load_runtime_cut(artifact_root, source, snapshot_path):
    boot_payload, source_identity = _open_boot(artifact_root, source)
    state = load_x86_boot_cache(boot_payload).state
    raw = json.loads(snapshot_path.read_text(encoding='utf-8'))
    if raw.get('schema') not in (1, 2):
        raise ValueError('native runtime snapshot schema is unsupported')
    memory = state.memory
    for page, encoded in raw.get('dirty_pages', ()):
        page = int(page)
        payload = base64.b64decode(encoded, validate=True)
        if page < 0 or len(payload) != 4096:
            raise ValueError('native runtime dirty page is invalid')
        memory = memory.write(page * 4096, payload)
    saved = raw['state']
    system = tuple(map(_word, saved['system']))
    if len(saved['registers']) != 16 or len(system) != 22:
        raise ValueError('native runtime state shape is invalid')
    state = replace(
        state,
        memory=memory,
        registers=tuple(map(_word, saved['registers'])),
        rip=_word(saved['rip']), rflags=_word(saved['rflags']),
        cr0=_word(saved['cr0']), cr2=system[0], cr3=_word(saved['cr3']),
        cr4=_word(saved['cr4']), cr8=system[1], efer=_word(saved['efer']),
        gdtr=system[2:4], idtr=system[4:6],
        es=system[6], cs=system[7], ss=system[8], ds=system[9],
        fs=system[10], gs=system[11], ldtr=system[12], tr=system[13],
        debug=system[14:22],
        msrs=tuple((_word(key), _word(value))
                   for key, value in saved['msrs']),
        xmm=tuple(map(_word, saved.get('xmm', ('0',) * 32))))
    try:
        ports = tuple(sorted(
            (int(coordinate), _word(value))
            for coordinate, value in saved.get('io_ports', ())))
        console_input = base64.b64decode(
            saved.get('console_input', ''), validate=True)
        console_output = base64.b64decode(
            saved.get('console_output', ''), validate=True)
    except (TypeError, ValueError) as error:
        raise ValueError('native runtime device state is invalid') from error
    if (len({coordinate for coordinate, _value in ports}) != len(ports)
            or any(coordinate < 0 or value < 0
                   for coordinate, value in ports)):
        raise ValueError('native runtime device coordinates are invalid')
    machine = X86MachineState(
        state, io_ports=ports, console_input=console_input,
        console_output=console_output)
    return machine, source_identity, len(raw.get('dirty_pages', ()))


def close(machine_payload, state, budget, max_internal):
    dbt = X86DBT(profile_controls=True)
    runtime = X86Machine(dbt)
    terminal = state if isinstance(state, X86MachineState) \
        else runtime.start(state)
    # A vm.wasm coverage fault may name the retry coordinate of a faultable
    # instruction split from the block that first reached it. Execution
    # profiling starts only after a transition completes, so seed that exact
    # coordinate before advancing. Otherwise a long oracle run can discover
    # thousands of neighboring cuts yet omit the one record the VM requested.
    try:
        seed_cut = dbt.physical_block(terminal.cpu)
    except PageFault:
        # Composition may inspect an as-yet-unmapped call target.  The exact
        # current block is still a valid closure seed; the guest page-fault
        # path will make the stronger successor available in a later round.
        seed_cut = dbt.block(terminal.cpu)
    response = None
    event = None
    remaining = max(1, int(budget))
    handled = Counter()
    console = bytearray()
    stalled = None
    while remaining > 0:
        terminal, event = runtime.machine_step(
            terminal, response, budget=remaining, max_internal=max_internal,
            clock_step=1)
        response = None
        cost = getattr(event, 'cost', None) or runtime.last_cost
        spent = int(cost.instructions) if cost is not None else 0
        if (not terminal.cpu.halted and spent <= 0
                and (event is None
                     or event.operation != 'console_write')):
            stalled = {
                'rip': '%016x' % terminal.cpu.rip,
                'event': None if event is None else event.operation,
            }
            break
        remaining -= min(remaining, max(0, spent))
        if event is None:
            if terminal.cpu.halted:
                break
            continue
        handled[event.operation] += 1
        if event.operation == 'console_write':
            if event.data:
                console.extend(bytes(event.data))
            continue
        if event.operation == 'entropy':
            value = ((terminal.cpu.rip * 0x9e3779b97f4a7c15
                      + 0xd1b54a32d192ed03) & ((1 << 64) - 1))
            response = MachineEvent(
                'entropy', event.coordinate, value)
            continue
        break

    cuts = [seed_cut]
    seed_rip = int(seed_cut.rip)
    cuts.extend(cut for rip, cut in dbt._physical_retry_cuts.items()
                if int(rip) != seed_rip)
    rejected = []
    for rip in native_x86_cut_coordinates(dbt):
        if int(rip) == seed_rip:
            continue
        cut = select_physical_cut(dbt, rip)
        if cut is None:
            rejected.append({
                'rip': '%016x' % rip,
                'operation': 'missing-cut',
            })
            continue
        try:
            packed = pack_native_x86_records(cut)
        except (StatePageError, TypeError, ValueError) as error:
            rejected.append({
                'rip': '%016x' % rip,
                'operation': cut.boundary.operation,
                'detail': repr(cut.boundary.detail),
                'reason': str(error),
            })
            continue
        cuts.append(cut)
    portable = []
    for cut in cuts:
        try:
            pack_native_x86_records(cut)
        except (StatePageError, TypeError, ValueError) as error:
            rejected.append({
                'rip': '%016x' % cut.rip,
                'operation': cut.boundary.operation,
                'detail': repr(cut.boundary.detail),
                'reason': str(error),
            })
            continue
        portable.append(cut)
    records = list(canonical_native_x86_records(portable))
    # Close the same static descriptor edges as the initial artifact build.
    # Retry records often end at the next instruction coordinate; requiring a
    # second runtime miss for an edge already named by the descriptor is an
    # avoidable N+1 admission path.
    metadata, memory, resident_by_proof = \
        load_native_x86_physical_machine(machine_payload)
    optimized_replacements = []
    for candidate_rip, candidate_record in records:
        fields, candidate_guard, candidate_physical = \
            physical_native_x86_record(candidate_record, candidate_rip)
        prior = resident_by_proof.get((
            int(candidate_rip) & ((1 << 64) - 1), candidate_guard))
        if prior is not None and prior != candidate_physical:
            optimized_replacements.append((
                int(candidate_rip) & ((1 << 64) - 1), int(fields[6])))
    known = {rip for rip, _guard in resident_by_proof}
    known.update(rip for rip, _record in records)
    frontier = list(records)
    attempted = set()
    static_records = 0
    while frontier and len(attempted) < 4096:
        successors = set()
        for _rip, record in frontier:
            successors.update(native_x86_static_successors(record))
        frontier = []
        for rip in sorted(successors.difference(known).difference(attempted)):
            if len(attempted) >= 4096:
                break
            attempted.add(rip)
            try:
                cut = dbt.physical_block(replace(terminal.cpu, rip=rip))
                packed = pack_native_x86_records(cut)
            except (StatePageError, TypeError, ValueError):
                continue
            for coordinate, record in packed:
                if coordinate in known:
                    continue
                known.add(coordinate)
                records.append((coordinate, record))
                frontier.append((coordinate, record))
                static_records += 1
    extended = extend_loaded_native_x86_physical_machine(
        metadata, memory, resident_by_proof, records,
        reject_conflicts=False,
        replace_proved=True)
    return extended, {
        'budget': int(budget),
        'consumed_instructions': int(budget) - remaining,
        'handled_events': dict(sorted(handled.items())),
        'console_bytes': len(console),
        'console_tail': bytes(console[-4096:]).decode(
            'utf-8', errors='replace'),
        'records': len(records),
        'static_records': static_records,
        'optimized_replacements': len(optimized_replacements),
        'optimized_replacement_controls': dict(sorted(Counter(
            control for _rip, control in optimized_replacements).items())),
        'optimized_replacement_sample': [
            {'rip': '%016x' % rip, 'control': control}
            for rip, control in optimized_replacements[:32]],
        'added_bytes': len(extended) - len(machine_payload),
        'terminal_rip': '%016x' % terminal.cpu.rip,
        'terminal_event': None if event is None else event.operation,
        'halted': bool(terminal.cpu.halted),
        'stalled': stalled,
        'grammar_misses': {
            'count': len(rejected),
            'by_operation': dict(sorted(Counter(
                item['operation'] for item in rejected).items())),
            'sample': rejected[:32],
        },
        'layout': dbt.layout(),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    parser.add_argument('--machine', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path)
    # Retain the exact runtime cut, then follow only its realized state for a
    # bounded local slice. This removes one-process-per-block admission while
    # avoiding a speculative sweep of the surrounding control-flow domain.
    parser.add_argument('--budget', type=int, default=2048)
    parser.add_argument('--max-internal', type=int, default=1)
    arguments = parser.parse_args(argv)

    state, source_identity, dirty_pages = load_runtime_cut(
        arguments.artifact_root, arguments.source, arguments.snapshot)
    machine_payload = arguments.machine.read_bytes()
    extended, report = close(
        machine_payload, state, arguments.budget, arguments.max_internal)
    report.update({
        'kind': 'native-x86-runtime-closure-v1',
        'source_identity': source_identity,
        'dirty_pages': dirty_pages,
        'before_bytes': len(machine_payload),
        'after_bytes': len(extended),
    })
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(extended)
    encoded = json.dumps(report, indent=2, sort_keys=True) + '\n'
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(encoded, encoding='utf-8', newline='\n')
    print(encoded, end='')
    return int(bool(report['grammar_misses']['count']))


if __name__ == '__main__':
    raise SystemExit(main())
