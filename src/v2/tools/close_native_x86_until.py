#!/usr/bin/env python3
"""Iteratively close vm.wasm coverage cuts until a console marker appears."""

import argparse
import base64
from bisect import bisect_right
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.close_native_x86_runtime import (close, load_runtime_cut,
                                            load_seed_catalog,
                                            load_seed_coordinates,
                                            linear_seed_coordinates,
                                            reachable_seed_coordinates)
from kernel.x86 import initial_state, PageFault, read_virtual
from qm.wasmstate import PagedMemory
from tools.build_native_x86_seed_addresses import (executable_segments,
                                                   executable_symbols)
from tools.index_native_x86_elf import executable_pages


def _run(node, runner, machine, wasm, blocks, snapshot, resume=None,
         console_input_base64=None, stop_console=None):
    command = (str(node), str(runner), str(machine), str(wasm), str(blocks),
               str(snapshot))
    if resume is not None:
        command += (str(resume),)
    environment = os.environ.copy()
    # Input belongs to one persistent machine cut.  Later closure rounds
    # resume the snapshot, which already contains every unconsumed UART byte;
    # injecting it again corrupts commands at each coverage fault.
    if console_input_base64 is not None:
        environment['QM_X86_CONSOLE_INPUT_BASE64'] = console_input_base64
    else:
        environment.pop('QM_X86_CONSOLE_INPUT_BASE64', None)
        environment.pop('QM_X86_CONSOLE_INPUT', None)
    if stop_console is not None:
        environment['QM_X86_STOP_CONSOLE'] = stop_console
    else:
        environment.pop('QM_X86_STOP_CONSOLE', None)
    completed = subprocess.run(
        command, cwd=REPOSITORY, capture_output=True, text=True,
        encoding='utf-8', errors='replace', check=False, env=environment)
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
    initial_console_input_base64 = arguments.console_input_base64
    console_input_base64 = initial_console_input_base64
    seed_coordinates = load_seed_coordinates(arguments.seed_addresses)
    seed_catalog = load_seed_catalog(arguments.seed_catalog)
    dense_objects = []
    for path in arguments.dense_seed_elf:
        dense_payload = path.read_bytes()
        dense_segments = executable_segments(dense_payload)
        dense_objects.append({
            'path': str(path),
            'symbols': executable_symbols(dense_payload),
            'segments': dense_segments,
            'ranges': tuple(
                (address, address + len(payload))
                for address, payload in dense_segments),
            'pages': {
                address: hashlib.sha256(payload).digest()
                for address, payload in executable_pages(
                    dense_payload).items()
            },
            'cpu': None,
        })

    def dense_object_at(cpu, coordinate):
        """Select one ELF by the current executable page, never RIP alone."""
        if not dense_objects:
            return None
        page = int(coordinate) & -4096
        try:
            identity = hashlib.sha256(
                read_virtual(cpu, page, 4096, 'execute')).digest()
        except PageFault:
            return None
        matched = [item for item in dense_objects
                   if item['pages'].get(page) == identity]
        if len(matched) != 1:
            return None
        item = matched[0]
        if item['cpu'] is None:
            memory = PagedMemory(
                b'', max(end for _start, end in item['ranges']))
            for address, payload in item['segments']:
                memory = memory.write(address, payload)
            item['cpu'] = initial_state(memory)
        return item

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
            run_blocks, snapshot, resume, console_input_base64,
            arguments.stop_console)
        console_input_base64 = None
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
        close_budget = arguments.budget
        round_seed_coordinates = seed_coordinates
        dense_span = None
        dense_coordinates = ()
        dense_decode_stops = []
        reachable_coordinates = ()
        reachable_decode_stops = ()
        reachable_truncated = False
        missing = int(observed['missing_block'], 16)
        dense_object = dense_object_at(state.cpu, missing)
        if dense_object is not None:
            dense_symbols = dense_object['symbols']
            dense_seed_cpu = dense_object['cpu']
            index = bisect_right(dense_symbols, missing) - 1
            if 0 <= index + 1 < len(dense_symbols):
                start, end = dense_symbols[index:index + 2]
                if (start <= missing < end
                        and end - start <= arguments.dense_seed_max_bytes):
                    if (end - start
                            <= arguments.dense_seed_neighbor_max_bytes):
                        neighbor = index + 1
                        while (end - start
                               < arguments.dense_seed_min_batch_bytes
                               and neighbor + 1 < len(dense_symbols)):
                            following = dense_symbols[neighbor + 1]
                            if (following - end
                                    > arguments.dense_seed_neighbor_max_bytes
                                    or following - start
                                    > arguments.dense_seed_max_bytes):
                                break
                            end = following
                            neighbor += 1
                    dense_span = (start, end)
                    # The first coordinate is known from vm.wasm's exact
                    # missing-block cut.  Following symbol boundaries are
                    # trusted ELF entries.  Walk forward by decoded source
                    # extents inside each segment; decoding every byte used
                    # to materialize overlapping, unreachable SSA graphs.
                    segment_entries = [missing]
                    segment_entries.extend(
                        coordinate for coordinate in dense_symbols[index + 1:]
                        if coordinate < end)
                    decoded = set()
                    for segment_index, entry in enumerate(segment_entries):
                        segment_end = (segment_entries[segment_index + 1]
                                       if segment_index + 1
                                       < len(segment_entries) else end)
                        coordinates, stopped = linear_seed_coordinates(
                            dense_seed_cpu, entry, segment_end)
                        decoded.update(coordinates)
                        if stopped is not None:
                            dense_decode_stops.append(stopped)
                    # The runtime cut is mandatory even if a cold unsupported
                    # instruction stopped a later speculative segment.
                    decoded.add(missing)
                    (reachable_coordinates, reachable_decode_stops,
                     reachable_truncated) = reachable_seed_coordinates(
                        dense_seed_cpu, (missing,), dense_object['ranges'],
                        arguments.dense_seed_reachable_limit)
                    decoded.update(reachable_coordinates)
                    dense_coordinates = tuple(sorted(decoded))
                    round_seed_coordinates = tuple(sorted(
                        set(seed_coordinates).union(dense_coordinates)))
                    # Dense admission closes direct control edges, but return
                    # and indirect targets are runtime state.  Keep tracing
                    # the bounded oracle slice after admitting the dense
                    # graph so one canonical rewrite observes many such
                    # targets.  Restricting this to one instruction made the
                    # driver rewrite a kernel-sized directory once per
                    # indirect edge (an avoidable N+1 build-time path).
                    close_budget = arguments.budget
        extended, report = close(
            machine.read_bytes(), state,
            close_budget, arguments.max_internal, round_seed_coordinates,
            seed_catalog,
            seed_cpu=(None if dense_object is None
                      else dense_object['cpu']),
            seed_cpu_ranges=(() if dense_object is None
                             else dense_object['ranges']),
            seed_catalog_page_limit=arguments.seed_catalog_page_limit)
        if report['grammar_misses']['count']:
            raise RuntimeError(json.dumps(report['grammar_misses'], indent=2))
        next_machine = work / ('round-%02d.machine.bin' % iteration)
        next_machine.write_bytes(extended)
        close_report = {
            'source_identity': source_identity,
            'dirty_pages': dirty_pages,
            'records': int(report['records']),
            'static_records': int(report['static_records']),
            'reused_decoded_coordinates': int(
                report.get('reused_decoded_coordinates', 0)),
            'handled_events': report['handled_events'],
            'seed_catalog': report['seed_catalog'],
            'bytes': len(extended),
            'added_bytes': int(report['added_bytes']),
            'consumed_instructions': int(report['consumed_instructions']),
            'seed_source': report.get('seed_source', 'runtime'),
            'dense_seed_span': (None if dense_span is None else {
                'object': dense_object['path'],
                'start': '%016x' % dense_span[0],
                'end': '%016x' % dense_span[1],
                'bytes': dense_span[1] - dense_span[0],
                'coordinates': len(dense_coordinates),
                'decode_stops': dense_decode_stops[:8],
                'reachable_coordinates': len(reachable_coordinates),
                'reachable_decode_stops': list(reachable_decode_stops),
                'reachable_truncated': reachable_truncated,
            }),
            'terminal_rip': report['terminal_rip'],
            'terminal_event': report['terminal_event'],
            'halted': bool(report.get('halted')),
            'stalled': report.get('stalled'),
            'timing_ms': report.get('timing_ms', {}),
        }
        print(json.dumps({'close': close_report}, sort_keys=True), flush=True)
        rounds[-1]['close'] = close_report
        machine = next_machine
        if arguments.restart_from_cold:
            # A resume chain proves that each newly admitted block works at
            # its captured cut, but it does not prove that the final directory
            # contains every guarded variant reached from the original boot
            # state. Re-enter from the immutable bzImage/initrd state after
            # each extension when producing a distributable closure.
            resume = None
            console = ''
            console_input_base64 = initial_console_input_base64
        else:
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
    parser.add_argument('--budget', type=int, default=262144)
    parser.add_argument('--max-internal', type=int, default=64)
    parser.add_argument(
        '--seed-addresses', type=Path,
        help=('newline-delimited x86 instruction coordinates from a trusted '
              'build-time ELF disassembly'))
    parser.add_argument(
        '--seed-catalog', type=Path,
        help=('content-addressed executable-page catalog used to admit all '
              'resident instruction entries after the first cut in an ELF'))
    parser.add_argument(
        '--seed-catalog-page-limit', type=int, default=16,
        help=('nearest resident executable pages admitted from one content '
              'catalog cut; zero selects every resident page'))
    parser.add_argument(
        '--dense-seed-elf', type=Path, action='append', default=[],
        help=('when a missing coordinate lies between adjacent executable '
              'symbols in this fixed-address ELF, admit that complete '
              'guarded byte span instead of tracing a long oracle slice; '
              'repeat for executables sharing virtual coordinates'))
    parser.add_argument(
        '--dense-seed-max-bytes', type=int, default=1 << 20,
        help='maximum adjacent-symbol span admitted by --dense-seed-elf')
    parser.add_argument(
        '--dense-seed-min-batch-bytes', type=int, default=4096,
        help=('coalesce consecutive small symbol spans until this guarded '
              'batch size is reached'))
    parser.add_argument(
        '--dense-seed-neighbor-max-bytes', type=int, default=256,
        help='largest neighboring symbol span eligible for coalescing')
    parser.add_argument(
        '--dense-seed-reachable-limit', type=int, default=4096,
        help=('maximum direct call/branch entries admitted from the current '
              'content-matched ELF cut'))
    parser.add_argument('--target', default='BusyBox')
    parser.add_argument('--console-input-base64',
                        help=('base64 console bytes injected once before the '
                              'first resumed quantum'))
    parser.add_argument(
        '--stop-console',
        help=('stop each VM run at the first browser-sized quantum whose '
              'new console output contains this marker'))
    parser.add_argument(
        '--restart-from-cold', action='store_true',
        help=('after each coverage extension, restart from the immutable boot '
              'state and re-inject console input; use for publishable closure'))
    parser.add_argument('--report', type=Path)
    arguments = parser.parse_args(argv)
    if arguments.node is None:
        parser.error('node is required')
    if arguments.console_input_base64 is not None:
        try:
            console_input = base64.b64decode(
                arguments.console_input_base64, validate=True)
        except (ValueError, TypeError) as error:
            parser.error('console input must be valid base64: %s' % error)
        if arguments.target.encode('utf-8') in console_input:
            parser.error(
                'target must not occur literally in console input; construct '
                'the success marker at runtime so UART echo cannot satisfy it')
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
