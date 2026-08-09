#!/usr/bin/env python3
"""Run a native LKL WebAssembly kernel to its next scheduler boundary.

The guest owns Linux syscalls and VFS state. This runner resolves only the
deterministic, nonblocking part of ``env.nccc_call64`` and stops before an
operation that requires choosing or waking a continuation.
"""

import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.host import LinuxHostState, NCCC_IMPORT, prepare_linux_memory
from kernel.scheduler import KernelScheduler, start_scheduler
from qm.wasmstate import decode_module, start_state
from qm.wasmwave import WaveExecutor


def run(path, entry='init', max_events=64, budget=1 << 17):
    with open(path, 'rb') as handle:
        raw = handle.read()
    started = time.perf_counter()
    module = decode_module(raw)
    decoded_seconds = time.perf_counter() - started
    machine = start_state(module, entry, host_imports=(NCCC_IMPORT,))
    machine, host = prepare_linux_memory(machine, LinuxHostState())
    executor = WaveExecutor(module)
    scheduler = KernelScheduler(module, executor)
    state = start_scheduler(machine, host)
    events = []

    for index in range(max_events):
        started = time.perf_counter()
        state, boundary = scheduler.step(state, budget=budget)
        elapsed = time.perf_counter() - started
        event = {
            'index': index,
            'thread': boundary.thread,
            'operation': boundary.operation,
            'action': boundary.action,
            'seconds': elapsed,
            'execution': boundary.cost.layout(),
        }
        if boundary.detail is not None:
            event['detail'] = boundary.detail
        events.append(event)
        if boundary.action == 'stalled':
            break

    resident = len(module.memory.base) + sum(
        len(page) for _index, page in module.memory.pages)
    runtime_resident = len(state.memory.base) + sum(
        len(page) for _index, page in state.memory.pages)
    return {
        'module_bytes': len(raw),
        'decode_seconds': decoded_seconds,
        'functions': len(module.functions),
        'table_slots': [len(table) for table in module.tables],
        'memory_bytes': len(module.memory),
        'logical_runtime_memory_bytes': len(state.memory),
        'resident_initial_bytes': resident,
        'resident_runtime_bytes': runtime_resident,
        'events': events,
        'threads': [
            {'handle': thread.handle, 'status': thread.status,
             'wait': thread.wait, 'result': thread.result}
            for thread in state.threads[1:] if thread is not None
        ],
        'physical_pages': len(executor.physical),
        'stopped_at_scheduler': bool(events and
                                     events[-1]['action'] == 'stalled'),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('module')
    parser.add_argument('--entry', default='init')
    parser.add_argument('--max-events', type=int, default=64)
    parser.add_argument('--budget', type=int, default=1 << 17,
                        help='maximum Wasm instructions per resumable quantum')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    report = run(args.module, args.entry, args.max_events, args.budget)
    if args.json:
        print(json.dumps(report, indent=2, default=list))
    else:
        print('module       %d bytes' % report['module_bytes'])
        print('decode       %.3f s' % report['decode_seconds'])
        for event in report['events']:
            suffix = ' [%s]' % event['action']
            print('%3d  t%-3d %-22s %9d instructions  %7.3f s%s'
                  % (event['index'], event['thread'], event['operation'],
                     event['execution']['wasm_instructions'],
                     event['seconds'], suffix))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
