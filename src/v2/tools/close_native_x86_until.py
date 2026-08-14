#!/usr/bin/env python3
"""Iteratively close vm.wasm coverage cuts until a console marker appears."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.close_native_x86_runtime import close, load_runtime_cut


def _run(node, runner, machine, wasm, blocks, snapshot, resume=None):
    command = (str(node), str(runner), str(machine), str(wasm), str(blocks),
               str(snapshot))
    if resume is not None:
        command += (str(resume),)
    completed = subprocess.run(
        command, cwd=REPOSITORY, capture_output=True, text=True,
        encoding='utf-8', errors='replace', check=False)
    if completed.returncode:
        raise RuntimeError(json.dumps({
            'node_exit': completed.returncode,
            'stdout_tail': completed.stdout.splitlines()[-16:],
            'stderr_tail': completed.stderr.splitlines()[-16:],
        }, indent=2))
    return json.loads(completed.stdout)


def close_until(arguments):
    work = Path(arguments.work)
    work.mkdir(parents=True, exist_ok=True)
    machine = Path(arguments.machine)
    rounds = []
    run_blocks = int(arguments.blocks)
    resume = arguments.resume
    console = ''

    def checkpoint():
        if arguments.report:
            arguments.report.parent.mkdir(parents=True, exist_ok=True)
            arguments.report.write_text(json.dumps({
                'target': arguments.target,
                'reached': False,
                'machine': str(machine),
                'rounds': rounds,
            }, indent=2, sort_keys=True) + '\n',
                encoding='utf-8', newline='\n')
    for iteration in range(1, int(arguments.rounds) + 1):
        snapshot = work / ('round-%02d.snapshot.json' % iteration)
        observed = _run(
            arguments.node, arguments.runner, machine, arguments.wasm,
            run_blocks, snapshot, resume)
        console += observed['console']
        run_report = {
            'round': iteration,
            'machine': str(machine),
            'requested_blocks': run_blocks,
            'completed_blocks': int(observed['completed_blocks']),
            'elapsed_ms': float(observed['elapsed_ms']),
            'missing_block': observed['missing_block'],
            'console_bytes': int(observed['console_bytes']),
            'console_tail': console[-512:],
            'resumed': bool(observed.get('resumed')),
        }
        print(json.dumps({'run': run_report}, sort_keys=True), flush=True)
        rounds.append({'run': run_report})
        checkpoint()
        if arguments.target in console:
            return machine, rounds, True
        if observed['missing_block'] is None:
            if int(observed['completed_blocks']) < run_blocks:
                raise RuntimeError('native machine stopped without a coverage cut')
            # The resident graph is closed for this quantum. A larger run can
            # continue without invoking the build oracle.
            run_blocks *= 2
            resume = snapshot
            continue

        state, source_identity, dirty_pages = load_runtime_cut(
            arguments.artifact_root, arguments.source, snapshot)
        extended, report = close(
            machine.read_bytes(), state,
            arguments.budget, arguments.max_internal)
        if report['grammar_misses']['count']:
            raise RuntimeError(json.dumps(report['grammar_misses'], indent=2))
        next_machine = work / ('round-%02d.machine.bin' % iteration)
        next_machine.write_bytes(extended)
        close_report = {
            'source_identity': source_identity,
            'dirty_pages': dirty_pages,
            'records': int(report['records']),
            'bytes': len(extended),
            'added_bytes': int(report['added_bytes']),
            'consumed_instructions': int(report['consumed_instructions']),
            'terminal_rip': report['terminal_rip'],
            'terminal_event': report['terminal_event'],
        }
        print(json.dumps({'close': close_report}, sort_keys=True), flush=True)
        rounds[-1]['close'] = close_report
        machine = next_machine
        resume = snapshot
        checkpoint()
    return machine, rounds, False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--machine', type=Path, required=True)
    parser.add_argument('--resume', type=Path,
                        help='resume the first VM run from this saved cut')
    parser.add_argument('--wasm', type=Path, default=ROOT / 'web' / 'vm.wasm')
    parser.add_argument('--node', type=Path,
                        default=shutil.which('node'))
    parser.add_argument('--runner', type=Path,
                        default=ROOT / 'tools' / 'run_native_x86_machine.mjs')
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=8)
    parser.add_argument('--blocks', type=int, default=10_000_000)
    # The runtime snapshot is the exact persistent cut selected by the native
    # VM. Follow its realized state through one bounded local slice so a run
    # does not pay one process launch per block; no neighboring state is swept.
    parser.add_argument('--budget', type=int, default=2048)
    parser.add_argument('--max-internal', type=int, default=1)
    parser.add_argument('--target', default='BusyBox')
    parser.add_argument('--report', type=Path)
    arguments = parser.parse_args(argv)
    if arguments.node is None:
        parser.error('node is required')
    machine, rounds, reached = close_until(arguments)
    result = {
        'target': arguments.target,
        'reached': reached,
        'machine': str(machine),
        'rounds': rounds,
    }
    encoded = json.dumps(result, indent=2, sort_keys=True) + '\n'
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(encoded, encoding='utf-8', newline='\n')
    print(encoded, end='')
    return int(not reached)


if __name__ == '__main__':
    raise SystemExit(main())
