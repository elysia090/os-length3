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
from kernel.x86 import (REGISTER_NAMES, X86DBT, X86Machine,
                        load_virtual)
from kernel.x86snapshot import (dump_x86_code_pages, load_x86_boot_cache,
                                pack_native_x86_block,
                                select_physical_cut)
from qm.stepnormalize import physical_work
from qm.steppage import (decode_projection_coordinate,
                         decode_relative_layout)


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
    control = dbt._control
    deliver_exception = dbt._deliver_exception
    conditional_transitions = Counter()
    device_boundaries = Counter()
    exception_trace = []

    def execute_with_context(state, block):
        try:
            return execute_plan(state, block)
        except Exception as error:
            from kernel.x86 import PageFault
            if isinstance(error, PageFault):
                raise
            raise RuntimeError(
                'x86 cut %#x failed: locals=%d scratch=%d boundary=%s '
                'waves=%r nodes=%r locals_out=%r'
                % (block.rip, block.mapped.local_extent,
                   block.scratch_count, block.boundary.operation,
                   block.plan.waves, block.plan.nodes,
                   block.plan.locals)) from error

    dbt._execute_plan = execute_with_context

    def control_with_transition(state, boundary, prior=None, scratch=(),
                                flag_cut=None):
        source = state.rip if prior is None else prior.rip
        after, published = control(
            state, boundary, prior, scratch, flag_cut)
        if boundary.operation == 'conditional_branch' and published is None:
            conditional_transitions[(int(source), int(after.rip))] += 1
        if (published is not None
                and published.operation in ('port_read', 'port_write')):
            device_boundaries[(published.operation,
                               tuple(map(int, published.detail)))] += 1
        return after, published

    dbt._control = control_with_transition

    def deliver_with_trace(state, vector, error_code):
        if len(exception_trace) < 32:
            msrs = dict(state.msrs)
            exception_trace.append({
                'vector': int(vector),
                'error_code': (None if error_code is None
                               else int(error_code)),
                'rip': int(state.rip),
                'rsp': int(state.register('rsp')),
                'cr2': int(state.cr2),
                'cs': int(state.cs),
                'fs_base': int(msrs.get(0xc0000100, 0)),
                'gs_base': int(msrs.get(0xc0000101, 0)),
                'kernel_gs_base': int(msrs.get(0xc0000102, 0)),
            })
        return deliver_exception(state, vector, error_code)

    dbt._deliver_exception = deliver_with_trace
    runtime = X86Machine(dbt)
    started = perf_counter()
    state, boundary = runtime.machine_step(
        runtime.start(boot.state), budget=budget,
        max_internal=max_internal, clock_step=clock_step,
        clock_variation_bits=clock_variation_bits)
    execute_seconds = perf_counter() - started

    def probe_words(address, count=16):
        words = []
        for index in range(count):
            try:
                words.append(load_virtual(
                    state.cpu, address + index * 8, 8))
            except Exception:
                words.append(None)
        return tuple(words)

    physical = dbt.layout()
    code = dump_x86_code_pages(dbt)
    executed_cut_bytes = 0
    boundary_coordinates = []

    def reached_cut(rip):
        return select_physical_cut(dbt, rip)

    native_blocks = []
    native_rejections = Counter()
    native_rejection_coordinates = []
    native_source_instructions = 0
    for rip in dbt._physical_profile:
        cut = reached_cut(rip)
        if cut is None:
            native_rejections['executed coordinate has no resident cut'] += 1
            continue
        try:
            native_blocks.append(pack_native_x86_block(cut))
            native_source_instructions += cut.instructions
        except (TypeError, ValueError) as error:
            native_rejections[str(error)] += 1
            native_rejection_coordinates.append((
                int(rip), cut.boundary.operation, repr(cut.boundary.detail),
                str(error)))

    operation_work = Counter()
    boundary_cost = {}
    cut_shape_cost = {}
    work_buckets = {}
    dominant_cuts = []
    conditional_residuals = []
    alu_residuals = Counter()
    alu_residual_coordinates = []
    fused_alus = Counter()
    fused_affine_alus = Counter()
    dispatched_source_instructions = 0
    for rip, (count, work, span) in dbt._physical_profile.items():
        cut = reached_cut(rip)
        if cut is None:
            continue
        executed_cut_bytes += len(cut.mapped.data)
        unit_work = physical_work(cut.plan)
        unit_span = cut.plan.waves.span
        dispatched_source_instructions += count * (cut.instructions + 1)
        for node in cut.plan.nodes:
            if node.op == 'memory.i64.relative_exchange':
                node_work = len(decode_relative_layout(
                    node.arguments[4].value))
            elif node.op == 'memory.i64.load_region':
                node_work = node.arguments[2].value & 0xff
            else:
                node_work = 1
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
        nodes_by_value = {node.value: node for node in cut.plan.nodes}
        consumers = {node.value: [] for node in cut.plan.nodes}
        for consumer in cut.plan.nodes:
            for argument in consumer.arguments:
                if argument.kind == 'node':
                    consumers.setdefault(argument.value, []).append(
                        consumer.op)
                elif argument.kind == 'projection':
                    source, selector = decode_projection_coordinate(
                        argument.value)
                    consumers.setdefault(source, []).append(
                        '%s[%d]' % (consumer.op, selector))
        published = set()
        for output in cut.plan.stack + cut.plan.locals:
            if output.kind == 'node':
                published.add(output.value)
            elif output.kind == 'projection':
                published.add(decode_projection_coordinate(output.value)[0])

        def constant(operand):
            return operand.value if operand.kind == 'const' else None

        for node in cut.plan.nodes:
            if (node.op == 'lane64.X86_ALU'
                    and len(node.arguments) == 4
                    and node.arguments[3].kind == 'const'):
                descriptor = node.arguments[3].value
                fused_alus[(descriptor & 0x7f,
                            (descriptor >> 8) & 7,
                            bool(descriptor & (1 << 11)),
                            node.value in published,
                            tuple(consumers.get(node.value, ())))] += count
            if (node.op == 'lane64.X86_AFFINE_ALU'
                    and len(node.arguments) == 5
                    and node.arguments[4].kind == 'const'):
                descriptor = node.arguments[4].value
                fused_affine_alus[(descriptor & 0x7f,
                                   (descriptor >> 8) & 7,
                                   bool(descriptor & (1 << 11)),
                                   node.value in published,
                                   tuple(consumers.get(
                                       node.value, ())))] += count
            if (node.op != 'lane64.X86_FLAGS'
                    or len(node.arguments) != 5
                    or node.arguments[4].kind != 'const'):
                continue
            descriptor = node.arguments[4].value
            width = descriptor & 0x7f
            mode = (descriptor >> 8) & 7
            result = node.arguments[3]
            result_node = (nodes_by_value.get(result.value)
                           if result.kind == 'node' else None)
            result_op = (result.kind if result_node is None
                         else result_node.op)
            matched = 'other'
            if result_node is not None:
                expected = node.arguments[1:3]
                if (mode == 0
                        and result_node.op in (
                            'lane64.AND', 'lane64.ANDR')
                        and result_node.arguments == expected):
                    matched = 'logical'
                elif (mode == 1
                      and result_node.op in (
                          'lane%d.ADD' % width,
                          'lane%d.ADDR' % width)
                      and result_node.arguments == expected):
                    matched = 'add'
                elif (mode == 3
                      and result_node.op in (
                          'lane%d.SUB' % width,
                          'lane%d.SUBR' % width)
                      and result_node.arguments == expected):
                    matched = 'sub'
                elif (mode == 3
                      and result_node.op in (
                          'lane%d.ADD' % width,
                          'lane%d.ADDR' % width)
                      and result_node.arguments[0] == expected[0]
                      and constant(result_node.arguments[1]) is not None
                      and constant(expected[1]) is not None
                      and (constant(result_node.arguments[1])
                           & ((1 << width) - 1))
                      == ((-constant(expected[1]))
                          & ((1 << width) - 1))):
                    matched = 'sub-as-add'
            result_consumers = tuple(
                operation for operation in consumers.get(
                    result.value, ()) if operation != 'lane64.X86_FLAGS') \
                if result.kind == 'node' else ()
            residual_shape = (
                width, mode, bool(descriptor & (1 << 11)), matched,
                result_op, result.value in published
                if result.kind == 'node' else False,
                result_consumers, node.value in published,
                tuple(consumers.get(node.value, ())))
            alu_residuals[residual_shape] += count
            alu_residual_coordinates.append((
                int(count), int(rip), int(node.value)) + residual_shape)
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
    for (rip, operation), count in dbt._control_profile.items():
        if operation != 'conditional_branch':
            continue
        cut = reached_cut(rip)
        if cut is None or cut.boundary.operation != operation:
            continue
        following, target, condition = cut.boundary.detail
        target_block = dbt.blocks.get(int(target))
        conditional_residuals.append((
            int(count), int(rip), int(target), int(condition),
            None if target_block is None
            else target_block.boundary.operation,
            int(target) < int(cut.rip), int(following)))
    conditional_residuals.sort(reverse=True)
    boundary_coordinates.sort(key=lambda item: (-item[2], item[0]))
    executed_work = (sum(
        work for _count, work, _span in dbt._physical_profile.values())
        + physical.get('recurrence_cut_executed_work', 0)
        + physical.get('prefix_cut_executed_work', 0)
        + physical.get('find_cut_executed_work', 0)
        + physical.get('copy_cut_executed_work', 0))
    executed_span = (sum(
        span for _count, _work, span in dbt._physical_profile.values())
        + physical.get('recurrence_cut_executed_span', 0)
        + physical.get('prefix_cut_executed_span', 0)
        + physical.get('find_cut_executed_span', 0)
        + physical.get('copy_cut_executed_span', 0))
    residual_source_instructions = (
        physical.get('recurrence_source_instructions', 0)
        + physical.get('prefix_source_instructions', 0)
        + physical.get('find_source_instructions', 0)
        + physical.get('copy_source_instructions', 0)
        + physical.get('direct_return_source_instructions', 0))
    retired_source_instructions = (
        dispatched_source_instructions + residual_source_instructions)
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
    result = {
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
            'terminal_rsp': int(state.cpu.registers[4]),
            'terminal_rflags': int(state.cpu.rflags),
            'terminal_registers': dict(
                (name, int(state.cpu.register(name)))
                for name in REGISTER_NAMES),
            'terminal_stack_words': probe_words(
                state.cpu.register('rsp')),
            'terminal_rbx_words': probe_words(
                state.cpu.register('rbx')),
            'terminal_rbx_aligned_words': probe_words(
                state.cpu.register('rbx') & ~7),
            'halted': bool(state.cpu.halted),
            'pending': (None if state.pending is None
                        else state.pending.operation),
            'console_bytes': len(state.console_output),
            'console_hex': state.console_output.hex(),
            'boundary': None if boundary is None else boundary.operation,
            'exception_trace': tuple(exception_trace),
            'execute_seconds': execute_seconds,
        },
        'code': {
            'archive_bytes': len(code),
            'decoded_blocks': physical['decoded_basic_blocks'],
            'resident_blocks': physical['resident_basic_blocks'],
            'source_instructions': physical['source_instructions'],
            'source_bytes_loaded': physical['source_bytes_loaded'],
            'native_blocks': len(native_blocks),
            'native_bytes': sum(map(len, native_blocks)),
            'native_source_instructions': native_source_instructions,
            'native_rejections': tuple(
                (count, reason) for reason, count
                in native_rejections.most_common()),
            'native_rejection_coordinates': tuple(
                native_rejection_coordinates),
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
            'executed_cuts': (sum(
                count for count, _work, _span
                in dbt._physical_profile.values())
                + physical.get('recurrence_cut_executions', 0)
                + physical.get('prefix_cut_executions', 0)
                + physical.get('find_cut_executions', 0)
                + physical.get('copy_cut_executions', 0)),
            'executed_work': executed_work,
            'executed_span': executed_span,
            'dispatched_source_instructions':
                dispatched_source_instructions,
            'residual_source_instructions': residual_source_instructions,
            'retired_source_instructions': retired_source_instructions,
            'physical_work_per_retired_source_instruction': (
                0.0 if not retired_source_instructions
                else executed_work / retired_source_instructions),
            'retired_source_instructions_per_physical_work': (
                0.0 if not executed_work
                else retired_source_instructions / executed_work),
            'dominant_operations': dominant_operations,
            'dominant_boundaries': dominant_boundaries,
            'dominant_shapes': dominant_shapes,
            'alu_residuals': tuple(
                (executions,) + shape
                for shape, executions in alu_residuals.most_common()),
            'alu_residual_coordinates': tuple(sorted(
                alu_residual_coordinates,
                key=lambda item: (-item[0], item[1], item[2]))),
            'fused_alus': tuple(
                (executions,) + shape
                for shape, executions in fused_alus.most_common()),
            'fused_affine_alus': tuple(
                (executions,) + shape for shape, executions
                in fused_affine_alus.most_common()),
            'work_distribution': work_distribution,
            'dominant_cuts': tuple(dominant_cuts),
            'boundary_coordinates': boundary_coordinates,
            'inlined_calls': inlined_calls,
            'conditional_residuals': tuple(conditional_residuals),
            'conditional_transitions': tuple(
                (count, source, target)
                for (source, target), count
                in conditional_transitions.most_common()),
            'device_boundaries': tuple(
                (count, operation, detail)
                for (operation, detail), count
                in device_boundaries.most_common()),
            'residual_counters': dict((name, physical.get(name, 0)) for name in (
                'recurrence_cuts', 'recurrence_cut_executions',
                'recurrence_cut_executed_work',
                'recurrence_cut_executed_span',
                'recurrence_source_instructions',
                'collapsed_repeat_iterations',
                'prefix_cuts', 'prefix_cut_executions',
                'prefix_cut_executed_work', 'prefix_cut_executed_span',
                'prefix_source_instructions',
                'collapsed_length_prefix_entries',
                'find_cuts', 'find_cut_cache_hits', 'find_cut_executions',
                'find_cut_executed_work', 'find_cut_executed_span',
                'find_source_instructions',
                'copy_cuts', 'copy_cut_cache_hits', 'copy_cut_bytes',
                'copy_cut_executions', 'copy_cut_executed_work',
                'copy_cut_executed_span', 'copy_source_instructions',
                'collapsed_return_branches', 'direct_return_branches',
                'direct_return_source_instructions',
                'compiled_byte_dispatches', 'collapsed_dispatch_iterations',
                'collapsed_residual_controls', 'threaded_controls')),
            'inspected': inspected,
        },
    }
    result['code']['residual_counters']['affine_clock_events'] = \
        runtime.affine_clock_events
    return result


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
    parser.add_argument('--metrics', action='store_true',
                        help='print only quantum retirement/work metrics')
    parser.add_argument('--inspect-rip', action='append', default=[],
                        type=lambda value: int(value, 0))
    args = parser.parse_args(argv)
    result = profile(
        args.artifact_root, args.name, args.budget, args.max_internal,
        args.clock_step, args.clock_variation_bits, args.inspect_rip)
    if args.metrics:
        selected = {
            'boot': result['boot'],
            'executed_work': result['code']['executed_work'],
            'executed_span': result['code']['executed_span'],
            'dispatched_source_instructions': result['code'][
                'dispatched_source_instructions'],
            'residual_source_instructions': result['code'][
                'residual_source_instructions'],
            'retired_source_instructions': result['code'][
                'retired_source_instructions'],
            'physical_work_per_retired_source_instruction': result['code'][
                'physical_work_per_retired_source_instruction'],
            'retired_source_instructions_per_physical_work': result['code'][
                'retired_source_instructions_per_physical_work'],
            'residual_counters': result['code']['residual_counters'],
            'alu_residuals': result['code']['alu_residuals'][:24],
            'alu_residual_coordinates': result['code'][
                'alu_residual_coordinates'][:48],
            'fused_alus': result['code']['fused_alus'][:16],
            'fused_affine_alus': result['code'][
                'fused_affine_alus'][:16],
            'device_boundaries': result['code']['device_boundaries'],
            'dominant_shapes': result['code']['dominant_shapes'][:8],
        }
    elif args.summary:
        selected = {
            'artifact': result['artifact'],
            'boot': result['boot'],
            'physical': {
                key: result['code'][key]
                for key in ('decoded_blocks', 'resident_blocks',
                            'raw_work', 'raw_span', 'work', 'span',
                            'removed_work', 'removed_span', 'native_blocks',
                            'native_bytes', 'native_source_instructions',
                            'native_rejections',
                            'native_rejection_coordinates')
            },
            'hot_physical_cuts': result['code']['hot_physical_cuts'][:16],
            'executed_boundaries': result['code']['executed_boundaries'],
            'executed_cut_bytes': result['code']['executed_cut_bytes'],
            'executed_cuts': result['code']['executed_cuts'],
            'executed_work': result['code']['executed_work'],
            'executed_span': result['code']['executed_span'],
            'dispatched_source_instructions': result['code'][
                'dispatched_source_instructions'],
            'residual_source_instructions': result['code'][
                'residual_source_instructions'],
            'retired_source_instructions': result['code'][
                'retired_source_instructions'],
            'physical_work_per_retired_source_instruction': result['code'][
                'physical_work_per_retired_source_instruction'],
            'retired_source_instructions_per_physical_work': result['code'][
                'retired_source_instructions_per_physical_work'],
            'residual_counters': result['code']['residual_counters'],
            'device_boundaries': result['code']['device_boundaries'],
            'dominant_operations': result['code'][
                'dominant_operations'][:24],
            'dominant_boundaries': result['code'][
                'dominant_boundaries'][:16],
            'dominant_shapes': result['code']['dominant_shapes'][:16],
            'alu_residuals': result['code']['alu_residuals'][:32],
            'alu_residual_coordinates': result['code'][
                'alu_residual_coordinates'][:64],
            'fused_alus': result['code']['fused_alus'][:16],
            'fused_affine_alus': result['code'][
                'fused_affine_alus'][:16],
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
