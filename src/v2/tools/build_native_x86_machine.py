#!/usr/bin/env python3
"""Compile reached x86 Linux cuts into one vm.wasm-native machine artifact."""

import argparse
from collections import Counter
from dataclasses import replace
import json
from pathlib import Path
import sys
from time import perf_counter


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.pagefabric import PageFabric, open_artifact, write_artifact
from kernel.x86 import X86DBT, X86Error, X86Machine
from kernel.x86snapshot import (dump_native_x86_machine,
                                load_x86_boot_cache,
                                native_x86_static_successors,
                                pack_native_x86_records,
                                select_physical_cut)
from qm.steppage import StatePageError


def _open_boot(artifact_root, name):
    catalog = json.loads(
        (artifact_root / 'index.json').read_text(encoding='utf-8'))
    entry = catalog['artifacts'][name]
    index = json.loads(
        (artifact_root / entry['path']).read_text(encoding='utf-8'))
    manifest, store = open_artifact(index, artifact_root, name)
    fabric = PageFabric(manifest, (store,))
    return fabric.read(0, fabric.length), index['identity']['digest']


def _reached_cut(dbt, rip):
    return select_physical_cut(dbt, rip)


def build(artifact_root, name, budget, max_internal, closure_blocks=4096):
    boot_payload, boot_identity = _open_boot(artifact_root, name)
    boot = load_x86_boot_cache(boot_payload)
    dbt = X86DBT(profile_controls=True)
    runtime = X86Machine(dbt)
    started = perf_counter()
    terminal = runtime.start(boot.state)
    event = None
    remaining = max(1, int(budget))
    output = bytearray()
    handled_events = Counter()
    # Output is an observable barrier, not a reason to stop discovering the
    # deterministic cuts after it. Consume only output-only events here. Any
    # input-bearing request remains the terminal cut and therefore cannot be
    # silently answered by the build oracle.
    while remaining > 0:
        terminal, event = runtime.machine_step(
            terminal, budget=remaining, max_internal=max_internal,
            clock_step=1)
        cost = getattr(event, 'cost', None) or runtime.last_cost
        spent = int(cost.instructions) if cost is not None else 0
        if not terminal.cpu.halted and spent <= 0:
            raise RuntimeError('live x86 discovery made no measurable progress')
        remaining -= min(remaining, max(0, spent))
        if event is None:
            if terminal.cpu.halted:
                break
            continue
        if event.operation != 'console_write':
            break
        output.extend(bytes(event.data or b''))
        handled_events[event.operation] += 1
    seconds = perf_counter() - started
    cuts = {}
    rejected = []
    for rip in dbt._physical_profile:
        cut = _reached_cut(dbt, rip)
        if cut is None:
            rejected.append((rip, 'executed coordinate has no resident cut'))
            continue
        try:
            pack_native_x86_records(cut)
        except (StatePageError, TypeError, ValueError) as error:
            rejected.append({
                'rip': '%016x' % (int(rip) & ((1 << 64) - 1)),
                'operation': cut.boundary.operation,
                'detail': repr(cut.boundary.detail),
                'reason': str(error),
            })
            continue
        cuts[int(rip)] = cut
    initial_cut_count = len(cuts)
    # A selected physical cut may be more general than the exact state that
    # first produced it.  Its conditional control can therefore name an edge
    # that the discovery trace did not take.  Decode that *one reached
    # frontier* against the final canonical memory image.  Continue only
    # through packable static edges, up to an explicit bound.  Dynamic control
    # remains a state coordinate and unsupported speculative paths remain
    # visible as grammar misses instead of acquiring an interpreter fallback.
    record_coordinates = set()
    closure_edge_set = set()
    frontier = list(cuts.values())
    attempted = set()
    unresolved_static = []
    closure_limit = initial_cut_count + max(0, int(closure_blocks))
    while frontier and len(cuts) < closure_limit:
        successors = set()
        for cut in frontier:
            for coordinate, record in pack_native_x86_records(cut):
                coordinate = int(coordinate)
                record_coordinates.add(coordinate)
                named = native_x86_static_successors(record)
                closure_edge_set.update(
                    (coordinate, successor) for successor in named)
                successors.update(named)
        frontier = []
        missing = sorted(successors.difference(record_coordinates)
                         .difference(attempted))
        for rip in missing:
            if len(cuts) >= closure_limit:
                break
            attempted.add(rip)
            cut = _reached_cut(dbt, rip)
            if cut is None:
                try:
                    cut = dbt.block(replace(terminal.cpu, rip=rip))
                except X86Error as error:
                    unresolved_static.append({
                        'rip': '%016x' % (rip & ((1 << 64) - 1)),
                        'reason': str(error),
                    })
                    continue
            try:
                pack_native_x86_records(cut)
            except (StatePageError, TypeError, ValueError) as error:
                unresolved_static.append({
                    'rip': '%016x' % (rip & ((1 << 64) - 1)),
                    'operation': cut.boundary.operation,
                    'detail': repr(cut.boundary.detail),
                    'reason': str(error),
                })
                continue
            cuts[rip] = cut
            frontier.append(cut)
    if rejected:
        raise RuntimeError('native x86 coverage is incomplete: %r' % rejected)
    blocks = tuple(cuts.values())
    payload = dump_native_x86_machine(boot_payload, boot.state, blocks)
    return payload, {
        'source_identity': boot_identity,
        'budget': int(budget),
        'max_internal': int(max_internal),
        'compile_seconds': seconds,
        'consumed_instructions': int(budget) - remaining,
        'handled_events': dict(sorted(handled_events.items())),
        'console_bytes': len(output),
        'console_tail': bytes(output[-160:]).decode('utf-8', 'replace'),
        'halted': bool(terminal.cpu.halted),
        'blocks': len(blocks),
        'static_closure_edges': len(closure_edge_set),
        'static_closure_blocks': len(blocks) - initial_cut_count,
        'static_closure_limit': int(closure_blocks),
        'static_closure_truncated': bool(frontier),
        'unresolved_static_successors': {
            'count': len(unresolved_static),
            'by_operation': dict(sorted(Counter(
                item.get('operation', 'decode')
                for item in unresolved_static).items())),
            'sample': unresolved_static[:32],
        },
        'bytes': len(payload),
        'terminal': {
            'rip': '%016x' % terminal.cpu.rip,
            'registers': ['%016x' % value
                          for value in terminal.cpu.registers],
            'rflags': '%016x' % terminal.cpu.rflags,
            'event': None if event is None else event.operation,
        },
        'layout': dbt.layout(),
    }


def publish(artifact_root, name, payload, report):
    written = write_artifact(
        payload, artifact_root, name, page_bytes=1 << 16,
        included_shards='data', replace=True)
    path = artifact_root / 'index.json'
    catalog = json.loads(path.read_text(encoding='utf-8'))
    catalog['artifacts'][name] = {
        'bytes': len(payload),
        'format': 'x86-native-machine-v1',
        'identity': written['identity']['digest'],
        'path': '%s/index.json' % name,
        'source_identity': report['source_identity'],
    }
    catalog['artifacts'] = dict(sorted(catalog['artifacts'].items()))
    path.write_text(json.dumps(catalog, indent=2, sort_keys=True) + '\n',
                    encoding='utf-8', newline='\n')
    return written['identity']['digest'], written['preferred']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--budget', type=int, default=4096)
    parser.add_argument('--max-internal', type=int, default=64)
    parser.add_argument('--closure-blocks', type=int, default=4096)
    parser.add_argument('--publish-name')
    arguments = parser.parse_args(argv)
    payload, report = build(
        arguments.artifact_root, arguments.source,
        arguments.budget, arguments.max_internal, arguments.closure_blocks)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(payload)
    if arguments.publish_name:
        identity, delivery = publish(
            arguments.artifact_root, arguments.publish_name, payload, report)
        report['identity'] = identity
        report['delivery'] = delivery
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
