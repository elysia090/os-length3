#!/usr/bin/env python3
"""Measure the reached x86 physical pages in one Linux machine quantum."""

import argparse
from collections import Counter
import json
from pathlib import Path
import sys
from time import perf_counter


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.pagefabric import PageFabric, open_artifact
from kernel.x86 import X86DBT, X86Machine
from kernel.x86snapshot import dump_x86_code_pages, load_x86_boot_cache
from qm.stepnormalize import physical_work
from qm.steppage import decode_relative_layout


def profile(artifact_root, name='linux-x86-64', budget=1 << 21,
            max_internal=1024, clock_step=1024,
            clock_variation_bits=12, inspect_rips=()):
    artifact_root = Path(artifact_root)
    catalog = json.loads(
        (artifact_root / 'index.json').read_text(encoding='utf-8'))
    entry = catalog['artifacts'][name]
    index = json.loads(
        (artifact_root / entry['path']).read_text(encoding='utf-8'))

    started = perf_counter()
    manifest, store = open_artifact(index, artifact_root, name)
    fabric = PageFabric(manifest, (store,))
    payload = fabric.read(0, fabric.length)
    artifact_seconds = perf_counter() - started
    started = perf_counter()
    boot = load_x86_boot_cache(payload)
    open_seconds = perf_counter() - started

    dbt = X86DBT(profile_controls=True)
    execute_plan = dbt._execute_plan

    def execute_with_context(state, block):
        try:
            return execute_plan(state, block)
        except Exception as error:
            from kernel.x86 import PageFault
            if isinstance(error, PageFault):
                raise
            raise RuntimeError(
                'x86 cut %#x failed: locals=%d scratch=%d boundary=%s'
                % (block.rip, block.mapped.local_extent,
                   block.scratch_count, block.boundary.operation)) from error

    dbt._execute_plan = execute_with_context
    runtime = X86Machine(dbt)
    started = perf_counter()
    state, boundary = runtime.machine_step(
        runtime.start(boot.state), budget=budget,
        max_internal=max_internal, clock_step=clock_step,
        clock_variation_bits=clock_variation_bits)
    execute_seconds = perf_counter() - started
    physical = dbt.layout()
    code = dump_x86_code_pages(dbt)
    executed_cut_bytes = 0
    boundary_coordinates = []

    def reached_cut(rip):
        cached = dbt._register_cuts.get(rip)
        cut = None if cached is None else cached[1]
        if cut is None:
            cached = dbt._stack_cuts.get(rip)
            cut = None if cached is None else cached[1]
        if cut is None:
            cached = dbt._predicate_cuts.get(rip)
            cut = None if cached is None else cached[1]
        return cut if cut is not None else dbt.blocks.get(rip)

    operation_work = Counter()
    boundary_cost = {}
    cut_shape_cost = {}
    work_buckets = {}
    dominant_cuts = []
    for rip, (count, work, span) in dbt._physical_profile.items():
        cut = reached_cut(rip)
        if cut is None:
            continue
        executed_cut_bytes += len(cut.mapped.data)
        unit_work = physical_work(cut.plan)
        unit_span = cut.plan.waves.span
        for node in cut.plan.nodes:
            node_work = (len(decode_relative_layout(
                node.arguments[4].value))
                if node.op == 'memory.i64.relative_exchange' else 1)
            operation_work[node.op] += count * node_work
        boundary_name = cut.boundary.operation
        aggregate = boundary_cost.setdefault(
            boundary_name, [0, 0, 0, set()])
        aggregate[0] += count
        aggregate[1] += work
        aggregate[2] += span
        aggregate[3].add(rip)
        bucket = work_buckets.setdefault(unit_work, [0, 0, 0, set()])
        bucket[0] += count
        bucket[1] += work
        bucket[2] += span
        bucket[3].add(rip)
        operations = tuple(node.op for node in cut.plan.nodes)
        shape = (boundary_name, unit_work, unit_span, operations)
        shaped = cut_shape_cost.setdefault(shape, [0, 0, 0, []])
        shaped[0] += count
        shaped[1] += work
        shaped[2] += span
        if len(shaped[3]) < 8:
            shaped[3].append(rip)
        dominant_cuts.append((
            rip, boundary_name, count, work, span, unit_work, unit_span,
            len(cut.source), operations))
        boundary_coordinates.append((
            rip, boundary_name, count, work, span, unit_work, unit_span))
    boundary_coordinates.sort(key=lambda item: (-item[2], item[0]))
    executed_work = sum(
        work for _count, work, _span in dbt._physical_profile.values())
    executed_span = sum(
        span for _count, _work, span in dbt._physical_profile.values())
    dominant_operations = tuple(
        (operation, work,
         0.0 if not executed_work else work / executed_work)
        for operation, work in operation_work.most_common())
    dominant_boundaries = tuple(sorted((
        (boundary, values[0], values[1], values[2], len(values[3]),
         0.0 if not executed_work else values[1] / executed_work)
        for boundary, values in boundary_cost.items()),
        key=lambda item: (-item[2], item[0])))
    dominant_shapes = tuple(sorted((
        (shape[0], values[0], values[1], values[2],
         shape[1], shape[2], shape[3], tuple(values[3]),
         0.0 if not executed_work else values[1] / executed_work)
        for shape, values in cut_shape_cost.items()),
        key=lambda item: (-item[2], item[0], item[4], item[5])))
    work_distribution = tuple(sorted((
        (unit_work, values[0], values[1], values[2], len(values[3]),
         0.0 if not executed_work else values[1] / executed_work)
        for unit_work, values in work_buckets.items()),
        key=lambda item: item[0]))
    dominant_cuts.sort(key=lambda item: (-item[3], -item[4], item[0]))
    inlined_calls = sorted((
        (rip, cut.inlined_call_target, physical_work(cut.plan),
         cut.plan.waves.span, cut.boundary.operation)
        for rip, (_sources, cut) in dbt._register_cuts.items()
        if cut.inlined_call_target is not None),
        key=lambda item: item[0])
    inspected = []
    for rip in map(int, inspect_rips):
        block = dbt.blocks.get(rip)
        carried = None if block is None else dbt._carry_flags_plan(block.plan)
        lowered = (None if carried is None or block is None else
                   dbt._lower_flag_boundary(carried, block.boundary))
        lowered_following = None if lowered is None else lowered[1]
        following_block = (None if lowered_following is None else
                           dbt.blocks.get(lowered_following))
        stack_cut = dbt._stack_cuts.get(rip)
        stack_cut = None if stack_cut is None else stack_cut[1]
        cut = dbt._register_cuts.get(rip)
        cut = None if cut is None else cut[1]
        if cut is None:
            predicate_cut = dbt._predicate_cuts.get(rip)
            cut = None if predicate_cut is None else predicate_cut[1]
        inspected.append({
            'rip': rip,
            'block_boundary': None if block is None else repr(block.boundary),
            'block_cut_inputs': (
                None if block is None else repr(block.cut_inputs)),
            'block_state_flags': (
                None if block is None else block.state_flags),
            'block_nodes': (None if block is None else
                            tuple(map(repr, block.plan.nodes))),
            'block_locals': (None if block is None else
                             tuple(map(repr, block.plan.locals))),
            'block_linear_end': (None if block is None else
                                 block.rip + len(block.source)),
            'lowered_following': lowered_following,
            'lowered_work': (None if lowered is None else
                             physical_work(lowered[0])),
            'following_cut_inputs': (
                None if following_block is None else
                repr(following_block.cut_inputs)),
            'following_boundary': (
                None if following_block is None else
                repr(following_block.boundary)),
            'following_state_flags': (
                None if following_block is None else
                following_block.state_flags),
            'following_locals': (
                None if following_block is None else
                tuple(map(repr, following_block.plan.locals))),
            'following_carries_flags': (
                None if following_block is None else
                dbt._carry_flags_plan(following_block.plan) is not None),
            'thunk_layout': (
                None if block is None
                or block.boundary.operation != 'call'
                else repr(dbt._indirect_thunk_layout(
                    state.cpu, block.boundary.detail[1]))),
            'stack_boundary': (
                None if stack_cut is None else repr(stack_cut.boundary)),
            'stack_target': (
                None if stack_cut is None
                else stack_cut.inlined_call_target),
            'cut_boundary': None if cut is None else repr(cut.boundary),
            'cut_target': None if cut is None else cut.inlined_call_target,
            'cut_work': None if cut is None else physical_work(cut.plan),
            'cut_span': None if cut is None else cut.plan.waves.span,
            'cut_nodes': (None if cut is None else
                          tuple(map(repr, cut.plan.nodes))),
            'cut_locals': (None if cut is None else
                           tuple(map(repr, cut.plan.locals))),
            'cut_source': None if cut is None else cut.source.hex(),
        })
    return {
        'artifact': {
            'identity': entry['identity'],
            'canonical_bytes': fabric.length,
            'delivery_pages': manifest.page_count,
            'delivery_unique_pages': manifest.rank_count,
            'decode_seconds': artifact_seconds,
        },
        'boot': {
            'open_seconds': open_seconds,
            'initial_rip': int(boot.state.rip),
            'terminal_rip': int(state.cpu.rip),
            'boundary': None if boundary is None else boundary.operation,
            'execute_seconds': execute_seconds,
        },
        'code': {
            'archive_bytes': len(code),
            'decoded_blocks': physical['decoded_basic_blocks'],
            'resident_blocks': physical['resident_basic_blocks'],
            'source_instructions': physical['source_instructions'],
            'source_bytes_loaded': physical['source_bytes_loaded'],
            'mapped_bytes': physical['mapped_bytes'],
            'raw_work': physical['frontend_raw_work'],
            'raw_span': physical['frontend_raw_span'],
            'work': physical['physical_work'],
            'span': physical['physical_span'],
            'removed_work': physical['qm_removed_work'],
            'removed_span': physical['qm_removed_span'],
            'materialized_pages': physical['materialized_pages'],
            'published_pages': physical['published_pages'],
            'forwarded_loads': physical['forwarded_loads'],
            'hot_controls': physical.get('hot_controls', ()),
            'hot_physical_cuts': physical.get('hot_physical_cuts', ()),
            'executed_boundaries': physical.get(
                'physical_boundaries', ()),
            'executed_cut_bytes': executed_cut_bytes,
            'executed_cuts': sum(
                count for count, _work, _span
                in dbt._physical_profile.values()),
            'executed_work': executed_work,
            'executed_span': executed_span,
            'dominant_operations': dominant_operations,
            'dominant_boundaries': dominant_boundaries,
            'dominant_shapes': dominant_shapes,
            'work_distribution': work_distribution,
            'dominant_cuts': tuple(dominant_cuts),
            'boundary_coordinates': boundary_coordinates,
            'inlined_calls': inlined_calls,
            'inspected': inspected,
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--name', default='linux-x86-64')
    parser.add_argument('--budget', type=int, default=1 << 21)
    parser.add_argument('--max-internal', type=int, default=1024)
    parser.add_argument('--clock-step', type=int, default=1024)
    parser.add_argument('--clock-variation-bits', type=int, default=12)
    parser.add_argument('--inlined-only', action='store_true')
    parser.add_argument('--summary', action='store_true',
                        help='print timings and only the hottest physical cuts')
    parser.add_argument('--inspect-rip', action='append', default=[],
                        type=lambda value: int(value, 0))
    args = parser.parse_args(argv)
    result = profile(
        args.artifact_root, args.name, args.budget, args.max_internal,
        args.clock_step, args.clock_variation_bits, args.inspect_rip)
    if args.summary:
        selected = {
            'artifact': result['artifact'],
            'boot': result['boot'],
            'physical': {
                key: result['code'][key]
                for key in ('decoded_blocks', 'resident_blocks',
                            'raw_work', 'raw_span', 'work', 'span',
                            'removed_work', 'removed_span')
            },
            'hot_physical_cuts': result['code']['hot_physical_cuts'][:16],
            'executed_boundaries': result['code']['executed_boundaries'],
            'executed_cut_bytes': result['code']['executed_cut_bytes'],
            'executed_cuts': result['code']['executed_cuts'],
            'executed_work': result['code']['executed_work'],
            'executed_span': result['code']['executed_span'],
            'dominant_operations': result['code'][
                'dominant_operations'][:24],
            'dominant_boundaries': result['code'][
                'dominant_boundaries'][:16],
            'dominant_shapes': result['code']['dominant_shapes'][:16],
            'work_distribution': result['code']['work_distribution'],
            'dominant_cuts': result['code']['dominant_cuts'][:24],
            'boundary_coordinates': result['code'][
                'boundary_coordinates'][:32],
            'inlined_calls': result['code']['inlined_calls'][:16],
            'inspected': result['code']['inspected'],
        }
    elif args.inspect_rip:
        selected = result['code']['inspected']
    elif args.inlined_only:
        selected = result['code']['inlined_calls']
    else:
        selected = result
    print(json.dumps(selected, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
