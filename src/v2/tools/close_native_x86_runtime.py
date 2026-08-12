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

from kernel.x86 import X86DBT, X86Machine
from kernel.x86snapshot import (canonical_native_x86_records,
                                extend_native_x86_machine,
                                load_x86_boot_cache,
                                pack_native_x86_records,
                                select_physical_cut)
from qm.steppage import StatePageError
from tools.build_native_x86_machine import _open_boot


def _word(value):
    return int(str(value), 16)


def load_runtime_cut(artifact_root, source, snapshot_path):
    boot_payload, source_identity = _open_boot(artifact_root, source)
    state = load_x86_boot_cache(boot_payload).state
    raw = json.loads(snapshot_path.read_text(encoding='utf-8'))
    if raw.get('schema') != 1:
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
                   for key, value in saved['msrs']))
    return state, source_identity, len(raw.get('dirty_pages', ()))


def close(machine_payload, state, budget, max_internal):
    dbt = X86DBT(profile_controls=True)
    runtime = X86Machine(dbt)
    terminal = runtime.start(state)
    event = None
    remaining = max(1, int(budget))
    handled = Counter()
    while remaining > 0:
        terminal, event = runtime.machine_step(
            terminal, budget=remaining, max_internal=max_internal,
            clock_step=1)
        cost = getattr(event, 'cost', None) or runtime.last_cost
        spent = int(cost.instructions) if cost is not None else 0
        if not terminal.cpu.halted and spent <= 0:
            raise RuntimeError('live x86 closure made no measurable progress')
        remaining -= min(remaining, max(0, spent))
        if event is None:
            if terminal.cpu.halted:
                break
            continue
        if event.operation != 'console_write':
            break
        handled[event.operation] += 1

    cuts = []
    rejected = []
    for rip in dbt._physical_profile:
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
    records = canonical_native_x86_records(cuts)
    extended = extend_native_x86_machine(
        machine_payload, records, reject_conflicts=False)
    return extended, {
        'budget': int(budget),
        'consumed_instructions': int(budget) - remaining,
        'handled_events': dict(sorted(handled.items())),
        'records': len(records),
        'added_bytes': len(extended) - len(machine_payload),
        'terminal_rip': '%016x' % terminal.cpu.rip,
        'terminal_event': None if event is None else event.operation,
        'halted': bool(terminal.cpu.halted),
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
    parser.add_argument('--budget', type=int, default=1 << 17)
    parser.add_argument('--max-internal', type=int, default=64)
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
