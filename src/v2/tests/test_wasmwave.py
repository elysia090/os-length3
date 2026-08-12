"""Dependency-wave execution between exact WebAssembly barriers."""

import base64
from dataclasses import replace
import json
import unittest
from unittest.mock import patch

from qm.wasmstate import (decode_module, instruction_step,
                          run_until_boundary, start_state)
from qm.steppage import (decode_plan, execute_mapped, pack, unpack,
                         compile_mapped_executor, memory_shape,
                         relative_layout, relative_exchange_values,
                         _relative_exchange,
                         StatePageError)
from qm.memorycut import MemoryCut
from qm.stepnormalize import compose_plans, normalize_plan
from qm.wasmphysical import DependencyWaves
from qm.wasmwave import (Operand, PureSlice, WaveExecutor, WaveNode,
                         execute_slice, is_barrier)
from tests.test_wasmbinary import encode_uleb, module


class TestWaveExecutor(unittest.TestCase):
    def test_u32_update_and_flags_share_one_physical_alu_lane(self):
        from qm.laneops import evaluate
        from qm.steppage import (decode_projection_coordinate,
                                 projection_coordinate)
        from qm.wasmstate import PagedMemory

        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.AND', (
                Operand('local', 0), Operand('const', 0xffffffff))),
             WaveNode(2, 'lane32.ADD', (
                Operand('node', 1), Operand('const', 1))),
             WaveNode(3, 'lane64.X86_FLAGS', (
                Operand('local', 1), Operand('node', 1),
                Operand('const', 1), Operand('node', 2),
                Operand('const', 32 | (1 << 8) | (1 << 11))))),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('node', 2), Operand('node', 3)))

        plan = normalize_plan(raw)
        self.assertEqual((len(plan.nodes), plan.waves.span), (1, 1))
        self.assertEqual(plan.nodes[0].op, 'lane64.X86_ALU')
        self.assertEqual(
            decode_projection_coordinate(plan.locals[0].value), (1, 16))
        execute = compile_mapped_executor(unpack(pack(plan)))
        prior = 0x247
        actual, _stack = execute(
            (0xffffffff, prior), (),
            MemoryCut(PagedMemory(b'', 65536)))
        expected_flags = evaluate('lane64.X86_FLAGS', (
            prior, 0xffffffff, 1, 0,
            32 | (1 << 8) | (1 << 11)))
        self.assertEqual(actual, (0, expected_flags))

        # The scalar decoder canonicalizes SUB(x, 1) as ADD(x, -1).
        # X86_ALU must recover the original subtraction descriptor so the
        # arithmetic result and flags still share one physical lane.
        decrement = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.AND', (
                Operand('local', 0), Operand('const', 0xffffffff))),
             WaveNode(2, 'lane32.ADD', (
                Operand('node', 1),
                Operand('const', 0xffffffffffffffff))),
             WaveNode(3, 'lane64.X86_FLAGS', (
                Operand('local', 1), Operand('node', 1),
                Operand('const', 1), Operand('node', 2),
                Operand('const', 32 | (3 << 8) | (1 << 11))))),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('node', 2), Operand('node', 3)))
        decrement = normalize_plan(decrement)
        self.assertEqual((len(decrement.nodes), decrement.waves.span), (1, 1))
        self.assertEqual(decrement.nodes[0].op, 'lane64.X86_ALU')
        execute_decrement = compile_mapped_executor(
            unpack(pack(decrement)))
        actual, _stack = execute_decrement(
            (0, prior), (), MemoryCut(PagedMemory(b'', 65536)))
        decrement_flags = evaluate('lane64.X86_FLAGS', (
            prior, 0, 1, 0xffffffff,
            32 | (3 << 8) | (1 << 11)))
        self.assertEqual(actual, (0xffffffff, decrement_flags))

        projected = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.X86_ALU', (
                Operand('local', 1), Operand('local', 0),
                Operand('const', 1),
                Operand('const', 32 | (1 << 8) | (1 << 11)))),
             WaveNode(2, 'lane64.ADD', (
                Operand('projection', projection_coordinate(1, 16)),
                Operand('const', 2)))),
            DependencyWaves((0,), (), (0,)), (Operand('node', 2),),
            (Operand('local', 0), Operand('node', 1)))
        projected = normalize_plan(projected)
        self.assertEqual(projected.waves.span, 2)
        execute = compile_mapped_executor(unpack(pack(projected)))
        locals_, stack = execute(
            (0xffffffff, prior), (),
            MemoryCut(PagedMemory(b'', 65536)))
        self.assertEqual((locals_, stack),
                         ((0xffffffff, expected_flags), (2,)))

    def test_partial_register_predicate_cut_reaches_its_closed_form(self):
        from qm.laneops import evaluate
        from qm.wasmstate import PagedMemory

        local = lambda value: Operand('local', value)
        node = lambda value: Operand('node', value)
        constant = lambda value: Operand('const', value)
        nodes = (
            WaveNode(1, 'memory.i64.load32_u', (
                local(6), constant(8), constant(65540))),
            WaveNode(2, 'lane64.ADD', (local(6), constant(8))),
            WaveNode(3, 'lane64.X86_TEST', (
                local(16), node(1), node(1), constant(32))),
            WaveNode(4, 'lane64.X86_CONDITION', (node(3), constant(5))),
            WaveNode(5, 'lane64.INSERT', (
                local(10), node(4), constant(8))),
            WaveNode(6, 'lane64.AND', (local(2), constant(0xffffffff))),
            WaveNode(7, 'lane64.SELECT', (node(1), node(6), node(4))),
            WaveNode(8, 'lane64.AND', (node(7), constant(0xffffffff))),
            WaveNode(9, 'lane64.SELECT', (node(2), local(1), node(4))),
            WaveNode(10, 'lane64.AND', (node(5), constant(0xffffffff))),
            WaveNode(11, 'lane64.AND', (local(8), constant(0xff))),
            WaveNode(12, 'lane64.AND', (node(5), constant(0xff))),
            WaveNode(13, 'lane64.ORR', (node(12), node(11))),
            WaveNode(14, 'lane64.INSERT', (node(10), node(13), constant(8))),
            WaveNode(15, 'lane64.ANDR', (node(11), node(12))),
            WaveNode(16, 'lane64.INSERT', (local(8), node(15), constant(8))),
            WaveNode(17, 'lane64.AND', (node(14), constant(0xff))),
            WaveNode(18, 'lane64.AND', (node(14), constant(1))),
            WaveNode(19, 'lane64.X86_FLAGS', (
                node(3), node(17), constant(1), node(18), constant(8))),
        )
        outputs = tuple(local(index) for index in range(17))
        outputs = (outputs[:6] + (node(9), outputs[7], node(16), node(8),
                   node(5), node(14)) + outputs[12:16] + (node(19),))
        raw = PureSlice(
            0, 0, 1, 1, 0, nodes,
            DependencyWaves((0,), (), (0,)), (), outputs)

        plan = normalize_plan(raw)
        execute = compile_mapped_executor(unpack(pack(plan)))
        self.assertEqual((len(plan.nodes), plan.waves.span), (12, 4))
        self.assertIn('lane32.INSERT', tuple(item.op for item in plan.nodes))
        for loaded in (0, 0x80000001):
            values = [0] * 17
            values[1] = 0x8877665544332211
            values[2] = 0xabcdef0123456789
            values[6] = 0x20
            values[8] = 0x123456789abcdef3
            values[10] = 0x9988776655443322
            values[16] = 0x246
            memory = bytearray(64)
            memory[0x28:0x2c] = loaded.to_bytes(4, 'little')
            actual, _stack = execute(
                tuple(values), (), MemoryCut(PagedMemory(memory, 65536)))
            predicate = int(bool(loaded))
            byte = (values[8] & 0xff) | predicate
            expected = list(values)
            expected[6] = values[6] + 8 if predicate else values[1]
            expected[8] = ((values[8] & ~0xff)
                           | ((values[8] & 0xff) & predicate))
            expected[9] = loaded if predicate else values[2] & 0xffffffff
            expected[10] = (values[10] & ~0xff) | predicate
            expected[11] = ((values[10] & 0xffffff00) | byte) & 0xffffffff
            expected[16] = evaluate(
                'lane64.X86_TEST', (values[16], byte, 1, 8))
            self.assertEqual(actual, tuple(expected))

    def test_length_prefixed_directory_is_one_residual_memory_lane(self):
        from qm.wasmstate import PagedMemory

        directory = (b'\x02aa' + b'\x81\x01' + b'b' * 129
                     + b'\x01c' + b'\x03ddd')
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'memory.i64.prefix_end', (
                Operand('local', 0), Operand('local', 1),
                Operand('local', 2), Operand('local', 3),
                Operand('const', memory_shape(1, virtual64=True)))),),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('node', 1), Operand('local', 1),
             Operand('local', 2), Operand('local', 3)))

        plan = normalize_plan(raw)
        mapped = unpack(pack(plan))
        execute = compile_mapped_executor(mapped)
        memory = MemoryCut(PagedMemory(directory, 65536))
        locals_, _stack = execute((0, 1, 2, 4), (), memory)

        self.assertEqual((mapped.work, mapped.span), (1, 1))
        self.assertEqual(locals_[0], len(directory))

    def test_relative_exchange_preserves_sequential_overlap_semantics(self):
        from qm.laneops import evaluate
        from qm.wasmstate import PagedMemory

        widths = (4, 4, 8)
        layout = relative_layout(widths)
        for left, right in ((64, 80), (64, 68), (68, 64), (64, 64)):
            source = PagedMemory(bytes(range(160)), 65536)
            delta = (left - right) & ((1 << 64) - 1)
            prior_flags = 0x246
            reference = MemoryCut(source)
            expected = []
            pending_right = []
            offset = 0
            last_left = last_result = 0
            for width in widths:
                mask = (1 << (width * 8)) - 1
                observed_right = reference.load(right + offset, width)
                next_left = (observed_right - delta) & mask
                observed_left = reference.load(left + offset, width)
                next_right = (observed_left + delta) & mask
                reference.write(
                    left + offset, next_left.to_bytes(width, 'little'))
                expected.extend((next_left, next_right))
                pending_right.append((offset, width, next_right))
                last_left, last_result = observed_left, next_right
                offset += width
            for offset, width, value in pending_right:
                reference.write(
                    right + offset, value.to_bytes(width, 'little'))
            expected.append(evaluate('lane64.X86_FLAGS', (
                prior_flags, delta, last_left, last_result,
                widths[-1] * 8 | (1 << 8))))

            actual = MemoryCut(source)
            results = _relative_exchange(
                actual, left, right, delta, prior_flags, layout)

            self.assertEqual(results, tuple(expected))
            self.assertEqual(actual.read(48, 64), reference.read(48, 64))

    def test_relative_exchange_matches_immutable_three_lane_snapshots(self):
        widths = (4, 4, 8)
        layout = relative_layout(widths)
        left = bytes.fromhex('01000000020000000300000000000000')
        right = bytes.fromhex('0a000000140000001e00000000000000')
        delta = (-16) & ((1 << 64) - 1)

        results = relative_exchange_values(left, right, delta, 0x246, layout)

        self.assertEqual(results[:6], (
            26, (1 + delta) & 0xffffffff,
            36, (2 + delta) & 0xffffffff,
            46, (3 + delta) & ((1 << 64) - 1)))

    def test_memory_root_does_not_hide_an_address_identity(self):
        empty_waves = DependencyWaves((0,), (), (0,))
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'i64.add', (
                Operand('local', 0), Operand('const', 0))),
             WaveNode(2, 'memory.i64.load', (
                 Operand('node', 1), Operand('const', 0),
                 Operand('const', memory_shape(8, virtual64=True))))),
            empty_waves, (Operand('node', 2),),
            (Operand('local', 0),))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['memory.i64.load'])
        self.assertEqual(plan.nodes[0].arguments[0], Operand('local', 0))
        self.assertEqual((plan.waves.work, plan.waves.span), (1, 1))

    def test_nested_publication_masks_intersect_before_materialization(self):
        empty_waves = DependencyWaves((0,), (), (0,))
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'i64.and', (
                Operand('local', 0), Operand('const', 0xff))),
             WaveNode(2, 'i64.and', (
                 Operand('node', 1), Operand('const', 0xffffffff)))),
            empty_waves, (), (Operand('node', 2),))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes], ['lane64.AND'])
        self.assertEqual(plan.nodes[0].arguments,
                         (Operand('local', 0), Operand('const', 0xff)))

    def test_conditional_x86_flags_are_one_physical_lane(self):
        empty_waves = DependencyWaves((0,), (), (0,))
        prior = Operand('local', 0)
        limit = (
            prior, Operand('const', 10), Operand('const', 2),
            Operand('const', 12), Operand('const', 64 | (1 << 8)))
        sentinel = (
            prior, Operand('const', 0), Operand('const', 0),
            Operand('const', 0), Operand('const', 8))
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.X86_FLAGS', limit),
             WaveNode(2, 'lane64.X86_FLAGS', sentinel),
             WaveNode(3, 'lane64.SELECT', (
                 Operand('node', 1), Operand('node', 2),
                 Operand('local', 1)))),
            empty_waves, (), (Operand('node', 3), Operand('local', 1)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.X86_FLAGS_SELECT'])
        self.assertEqual(plan.nodes[0].arguments,
                         limit + sentinel + (Operand('local', 1),))
        self.assertEqual((plan.waves.work, plan.waves.span), (1, 1))

    def test_overwritten_x86_flags_bypass_dead_intermediate_states(self):
        prior = Operand('local', 0)
        first = (prior, Operand('const', 9), Operand('const', 4),
                 Operand('const', 5), Operand('const', 64 | (3 << 8)))
        second = (Operand('node', 1), Operand('const', 5),
                  Operand('const', 2), Operand('const', 7),
                  Operand('const', 64 | (1 << 8)))
        raw = PureSlice(
            0, 0, 2, 2, 0,
            (WaveNode(1, 'lane64.X86_FLAGS', first),
             WaveNode(2, 'lane64.X86_FLAGS', second)),
            DependencyWaves((0,), (), (0,)), (), (Operand('node', 2),))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.X86_FLAGS'])
        self.assertEqual(plan.nodes[0].arguments[0], prior)
        self.assertEqual(plan.nodes[0].arguments[1:], second[1:])

    def test_compare_flags_consume_the_difference_without_materializing_it(self):
        descriptor = 64 | (3 << 8)
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.SUBR', (
                Operand('local', 0), Operand('local', 1))),
             WaveNode(2, 'lane64.X86_FLAGS', (
                 Operand('local', 2), Operand('local', 0),
                 Operand('local', 1), Operand('node', 1),
                 Operand('const', descriptor)))),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('local', 0), Operand('local', 1),
             Operand('node', 2)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.X86_COMPARE'])
        execute = compile_mapped_executor(unpack(pack(plan)))
        outputs, _stack = execute((3, 7, 0x246), (), object())
        from qm.laneops import evaluate
        self.assertEqual(outputs[2], evaluate('lane64.X86_FLAGS', (
            0x246, 3, 7, (3 - 7) & ((1 << 64) - 1), descriptor)))

    def test_test_flags_consume_the_mask_without_materializing_the_and(self):
        descriptor = 64
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.ANDR', (
                Operand('local', 0), Operand('local', 1))),
             WaveNode(2, 'lane64.X86_FLAGS', (
                 Operand('local', 2), Operand('local', 0),
                 Operand('local', 1), Operand('node', 1),
                 Operand('const', descriptor)))),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('local', 0), Operand('local', 1),
             Operand('node', 2)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.X86_TEST'])
        execute = compile_mapped_executor(unpack(pack(plan)))
        outputs, _stack = execute((0x81, 0x0f, 0x246), (), object())
        from qm.laneops import evaluate
        self.assertEqual(outputs[2], evaluate('lane64.X86_TEST', (
            0x246, 0x81, 0x0f, descriptor)))

    def test_x86_condition_lane_covers_every_condition_code(self):
        from qm.laneops import evaluate

        for flags in (0, 1, 1 << 2, 1 << 6, 1 << 7, 1 << 11,
                      0x8c5):
            carry = bool(flags & 1)
            parity = bool(flags & (1 << 2))
            zero = bool(flags & (1 << 6))
            sign = bool(flags & (1 << 7))
            overflow = bool(flags & (1 << 11))
            less = sign != overflow
            expected = (
                overflow, not overflow, carry, not carry,
                zero, not zero, carry or zero, not carry and not zero,
                sign, not sign, parity, not parity,
                less, not less, zero or less, not zero and not less,
            )
            for code, selected in enumerate(expected):
                self.assertEqual(
                    evaluate('lane64.X86_CONDITION', (flags, code)),
                    int(selected))

    def test_x86_bit_flags_change_only_the_carry_coordinate(self):
        from qm.laneops import evaluate

        for width in (16, 32, 64):
            for index in (0, 1, width - 1, width, width + 1):
                flags = evaluate('lane64.X86_BIT_FLAGS', (
                    0x2d7, 1 << (index & (width - 1)), index, width))
                self.assertEqual(flags, 0x2d7 | 1)
                cleared = evaluate('lane64.X86_BIT_FLAGS', (
                    0x2d7, 0, index, width))
                self.assertEqual(cleared, 0x2d6)

    def test_physical_x86_test_consumes_its_own_width_projections(self):
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.AND', (
                Operand('local', 0), Operand('const', 0xff))),
             WaveNode(2, 'lane64.AND', (
                 Operand('local', 1), Operand('const', 0xff))),
             WaveNode(3, 'lane64.X86_TEST', (
                 Operand('local', 2), Operand('node', 1),
                 Operand('node', 2), Operand('const', 8)))),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('local', 0), Operand('local', 1),
             Operand('node', 3)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.X86_TEST'])
        self.assertEqual(plan.nodes[0].arguments[1:3], (
            Operand('local', 0), Operand('local', 1)))

    def test_insert_lane_publishes_one_bit_field_without_scalar_masks(self):
        from qm.laneops import evaluate

        self.assertEqual(
            evaluate('lane64.INSERT', (0x1122334455667788, 0xab, 8)),
            0x11223344556677ab)
        self.assertEqual(
            evaluate('lane64.INSERT', (
                0x1122334455667788, 0xcd, 8 | (8 << 8))),
            0x112233445566cd88)

    def test_test_condition_is_one_closed_physical_lane(self):
        from qm.laneops import evaluate

        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.X86_TEST', (
                Operand('local', 0), Operand('local', 1),
                Operand('local', 1), Operand('const', 8))),
             WaveNode(2, 'lane64.X86_CONDITION', (
                 Operand('node', 1), Operand('const', 5)))),
            DependencyWaves((0,), (), (0,)),
            (Operand('node', 2),),
            (Operand('local', 0), Operand('local', 1)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.X86_TEST_CONDITION'])
        self.assertEqual(plan.nodes[0].arguments, (
            Operand('local', 1), Operand('local', 1),
            Operand('const', 8 | (5 << 8))))
        self.assertEqual(
            evaluate('lane64.X86_TEST_CONDITION',
                     (0xab, 0xff, 8 | (5 << 8))),
            1)

    def test_test_condition_bypasses_a_following_test_prior_chain(self):
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.X86_TEST', (
                Operand('local', 0), Operand('local', 1),
                Operand('local', 1), Operand('const', 64))),
             WaveNode(2, 'lane64.X86_CONDITION', (
                 Operand('node', 1), Operand('const', 4))),
             WaveNode(3, 'lane64.X86_TEST', (
                 Operand('node', 1), Operand('local', 2),
                 Operand('local', 2), Operand('const', 8)))),
            DependencyWaves((0,), (), (0,)),
            (Operand('node', 2),),
            (Operand('local', 0), Operand('local', 1),
             Operand('local', 2), Operand('node', 3)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes], [
            'lane64.X86_TEST_CONDITION', 'lane64.X86_TEST'])
        self.assertEqual(plan.nodes[1].arguments[0], Operand('local', 0))

    def test_terminal_branch_condition_projects_from_published_flags(self):
        from qm.steppage import (decode_projection_coordinate, pack, unpack)

        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.X86_TEST', (
                Operand('local', 0), Operand('local', 1),
                Operand('local', 1), Operand('const', 32))),
             WaveNode(2, 'lane64.X86_CONDITION', (
                 Operand('node', 1), Operand('const', 5)))),
            DependencyWaves((0,), (), (0,)),
            (Operand('node', 2),),
            (Operand('local', 0), Operand('local', 1),
             Operand('node', 1)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.X86_TEST'])
        self.assertEqual(plan.stack[0].kind, 'projection')
        self.assertEqual(
            decode_projection_coordinate(plan.stack[0].value), (1, 5))
        mapped = unpack(bytes(pack(plan)))
        self.assertEqual(mapped.work, 1)

    def test_u32_inputs_and_publications_keep_the_hot_cut_at_four_lanes(self):
        raw = PureSlice(
            0, 0, 6, 6, 0,
            (WaveNode(1, 'lane64.AND', (
                Operand('local', 2), Operand('const', 0xffffffff))),
             WaveNode(2, 'lane64.ADD3', (
                 Operand('local', 1), Operand('node', 1),
                 Operand('const', 1))),
             WaveNode(3, 'lane64.AND', (
                 Operand('local', 3), Operand('const', 0xffffffff))),
             WaveNode(4, 'lane64.EXTEND_I32_S', (
                 Operand('node', 3),)),
             WaveNode(5, 'lane64.ADD', (
                 Operand('node', 4), Operand('const', 1))),
             WaveNode(6, 'lane64.AND', (
                 Operand('node', 5), Operand('const', 0xffffffff))),
             WaveNode(7, 'lane64.X86_COMPARE', (
                 Operand('local', 4), Operand('local', 0),
                 Operand('node', 4), Operand('const', 64 | (3 << 8))))),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('local', 0), Operand('node', 2),
             Operand('node', 6), Operand('node', 4),
             Operand('node', 7)))

        plan = normalize_plan(raw)

        self.assertEqual([node.op for node in plan.nodes], [
            'lane64.ADD3_U32', 'lane64.EXTEND_I32_S',
            'lane32.ADD', 'lane64.X86_COMPARE'])
        self.assertEqual((plan.waves.work, plan.waves.span), (4, 2))

    def test_pre_store_waits_until_its_saved_value_is_available(self):
        shape = Operand('const', memory_shape(8, virtual64=True))
        raw = PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'lane64.SUB', (
                Operand('local', 0), Operand('const', 8))),
             WaveNode(2, 'lane64.ADD', (
                 Operand('local', 1), Operand('const', 1))),
             WaveNode(3, 'memory.i64.store', (
                 Operand('node', 1), Operand('node', 2),
                 Operand('const', 0), shape))),
            DependencyWaves((0,), (), (0,)), (),
            (Operand('node', 1), Operand('node', 2)))

        plan = normalize_plan(raw)

        self.assertNotIn('memory.i64.pre_store',
                         [node.op for node in plan.nodes])
        self.assertIn('memory.i64.store',
                      [node.op for node in plan.nodes])

    def test_deterministic_pages_compose_by_substituting_frame_coordinates(self):
        empty_waves = DependencyWaves((0,), (), (0,))
        first = normalize_plan(PureSlice(
            0, 0, 1, 1, 0,
            (WaveNode(1, 'i64.add', (
                Operand('local', 0), Operand('const', 1))),),
            empty_waves, (), (Operand('node', 1),)))
        second = normalize_plan(PureSlice(
            0, 1, 2, 1, 0,
            (WaveNode(1, 'i64.mul', (
                Operand('local', 0), Operand('const', 2))),),
            empty_waves, (), (Operand('node', 1),)))

        composed = compose_plans(first, second)
        execute = compile_mapped_executor(unpack(pack(composed)))
        outputs, stack = execute((5,), (), object())

        self.assertEqual(outputs, (12,))
        self.assertEqual(stack, ())
        self.assertEqual(composed.instructions, 2)

    def test_independent_integer_lanes_execute_in_the_same_wave(self):
        # (x & 255) + (x ^ 85): AND and XOR are independent, ADD joins them.
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        state = start_state(decoded, 'f', (0x1234,))

        plan = executor.plan(state.frames[-1])
        self.assertEqual(plan.waves.wave(1), (1, 2))
        self.assertEqual(plan.waves.wave(2), (3,))
        self.assertEqual(plan.layout()['max_parallel_width'], 2)

        state, cost = executor.step(state)
        self.assertEqual(state.frames[-1].pc, len(decoded.functions[0].code) - 1)
        self.assertEqual(state.frames[-1].stack,
                         (((0x1234 & 0xff) + (0x1234 ^ 0x55)) & 0xffffffff,))
        self.assertEqual(cost.layout(), {
            'wasm_instructions': 7,
            'work': 3,
            'span': 2,
            'pure_slices': 1,
            'barriers': 0,
            'max_parallel_width': 2,
        })
        finished, _end_cost = executor.step(state)
        self.assertTrue(finished.halted)
        self.assertEqual(
            executor.normalization_layout()['barrier_groups'], {'end': 1})

    def test_slice_normalization_substitutes_locals_and_folds_identities(self):
        # local1 = x + 0; return local1 ^ local1.
        body = (b'\x01\x01\x7f\x20\x00\x41\x00\x6a\x21\x01'
                b'\x20\x01\x20\x01\x73\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (0x1234,))

        plan = executor.plan(initial.frames[-1])
        self.assertEqual(plan.waves.work, 0)
        self.assertEqual(plan.stack[0].kind, 'const')
        self.assertEqual(plan.stack[0].value, 0)
        final, _report = executor.run_with_report(initial)
        self.assertEqual(final.result, (0,))

    def test_slice_normalization_shares_common_subexpressions(self):
        # (x & 255) + (x & 255) has two physical operations, not three.
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xff\x01\x71\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        plan = WaveExecutor(decoded).plan(
            start_state(decoded, 'f', (7,)).frames[-1])

        self.assertEqual(plan.waves.work, 2)
        self.assertEqual(plan.waves.span, 2)

    def test_whole_slice_normalization_becomes_one_state_step_page(self):
        # ((x + 1) * 3) - 3 is exactly x * 3.  Local Wasm folding cannot
        # remove the cross-node affine cancellation; whole-expression QM can.
        body = b'\x00\x20\x00\x42\x01\x7c\x42\x03\x7e\x42\x03\x7d\x0b'
        decoded = decode_module(module(body, kind=0x7e))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (9,))

        plan = executor.plan(initial.frames[-1])
        self.assertEqual([node.op for node in plan.nodes], ['lane64.IMUL'])
        self.assertEqual(plan.waves.work, 1)
        mapped = executor.mapped(initial.frames[-1])
        self.assertEqual(mapped.layout()['kind'], 'state-step-page')
        self.assertEqual(mapped.layout()['work'], 1)

        final, _report = executor.run_with_report(initial)
        self.assertEqual(final.result, (27,))
        self.assertEqual(
            executor.normalization_layout()['normalized_state_steps'], 1)

        for value in (0, 1, 9, 1 << 31, (1 << 64) - 1):
            reference = start_state(decoded, 'f', (value,))
            while not reference.halted and reference.waiting is None:
                reference = instruction_step(decoded, reference)
            optimized = executor.run(start_state(decoded, 'f', (value,)))
            self.assertEqual(optimized.result, reference.result)

    def test_float_memory_is_an_integer_bit_view_not_a_second_column(self):
        # load f32 bits, select either those bits or +0, then store the bits.
        body = (b'\x00\x20\x00\x20\x00\x2a\x02\x60'
                b'\x43\x00\x00\x00\x00\x20\x00\x2d\x00\x64'
                b'\x1b\x38\x02\x58\x0b')
        decoded = decode_module(module(
            body, kind=0x7f, memory=True, result_count=0))
        frame = start_state(decoded, 'f', (0,)).frames[-1]

        mapped = WaveExecutor(decoded).mapped(frame)

        from qm.steppage import OP_TO_CODE
        self.assertEqual(
            [mapped.value('opcodes', index) for index in range(mapped.work)],
            [OP_TO_CODE[name] for name in (
                'memory.i32.load', 'memory.i32.load8_u',
                'lane64.SELECT', 'memory.i32.store')])
        self.assertEqual(
            [decode_plan(mapped).nodes[index].op
             for index in range(mapped.work)],
            ['memory.i32.load', 'memory.i32.load8_u',
             'lane64.SELECT', 'memory.i32.store'])

    def test_each_future_visible_ssa_root_is_normalized_before_the_barrier(self):
        # The value and the following if-condition are two residual outputs of
        # one pure slice.  The affine value still reduces independently.
        body = (b'\x00\x20\x00\x42\x01\x7c\x42\x03\x7e\x42\x03\x7d'
                b'\x20\x00\x50\x04\x40\x0b\x0b')
        decoded = decode_module(module(body, kind=0x7e))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (9,))

        plan = executor.plan(initial.frames[-1])
        self.assertEqual([node.op for node in plan.nodes],
                         ['lane64.EQZ', 'lane64.IMUL'])
        self.assertEqual(plan.waves.wave(1), (1, 2))
        self.assertEqual(plan.waves.work, 2)
        final = executor.run(initial)
        self.assertEqual(final.result, (27,))

    def test_residual_roots_keep_a_cheaper_shared_prefix(self):
        # Both products share x + 1.  Optimizing each output independently
        # would duplicate that prefix, so the recomposed cut keeps the shared
        # four-node DAG until a jointly cheaper form is found.
        body = (b'\x01\x01\x7e\x20\x00\x42\x01\x7c\x22\x01'
                b'\x42\x03\x7e\x20\x01\x42\x05\x7e\x20\x00\x50'
                b'\x04\x40\x0b\x0b')
        decoded = decode_module(module(body, kind=0x7e))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (9,))

        plan = executor.plan(initial.frames[-1])
        self.assertEqual(plan.waves.work, 4)
        self.assertEqual(executor.run(initial).result, (50,))

    def test_backward_observer_removes_a_mask_hidden_by_i32_shift(self):
        body = (b'\x00\x20\x00\x41' + encode_uleb(0x1fffffff)
                + b'\x71\x41\x03\x74\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (0xf1234567,))

        plan = executor.plan(initial.frames[-1])
        self.assertEqual([node.op for node in plan.nodes], ['lane32.SHL'])
        self.assertEqual(executor.run(initial).result,
                         ((0xf1234567 << 3) & 0xffffffff,))

    def test_multi_coordinate_cut_recomposes_into_one_address_lane(self):
        # Two independent parameters cannot enter the scalar single-input
        # solver.  Their physical cut is still one a+b+immediate address lane.
        body = b'\x00\x20\x00\x20\x01\x6a\x41\x07\x6a\x0b'
        decoded = decode_module(module(
            body, kind=0x7f, parameter_count=2))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (11, 23))

        plan = executor.plan(initial.frames[-1])
        self.assertEqual([node.op for node in plan.nodes], ['lane32.ADD3'])
        self.assertEqual(plan.waves.work, 1)
        self.assertEqual(executor.run(initial).result, (41,))

    def test_dynamic_bit_observer_is_one_physical_lane(self):
        # (((x >> coordinate) & 1) == 0) is an observer of one coordinate,
        # not a materialized shift, mask, and comparison chain.
        body = (b'\x00\x20\x00\x20\x01\x76\x41\x01\x71\x45\x0b')
        decoded = decode_module(module(
            body, kind=0x7f, parameter_count=2))
        executor = WaveExecutor(decoded)

        for value, coordinate in ((0, 0), (1, 0), (8, 3), (8, 2),
                                  (0x80000000, 31)):
            with self.subTest(value=value, coordinate=coordinate):
                initial = start_state(decoded, 'f', (value, coordinate))
                plan = executor.plan(initial.frames[-1])
                self.assertEqual([node.op for node in plan.nodes],
                                 ['lane32.BITZ'])
                expected = 1 ^ ((value >> (coordinate & 31)) & 1)
                self.assertEqual(executor.run(initial).result, (expected,))

    def test_msb_first_byte_observer_does_not_materialize_bit_coordinate(self):
        # (byte >> ((~coordinate) & 7)) & 1 is the codec's MSB-first byte
        # coordinate.  The complement/mask belongs to the observer lane.
        body = (b'\x00\x20\x00\x20\x01\x41\x7f\x73\x41\x07\x71'
                b'\x76\x41\x01\x71\x45\x0b')
        decoded = decode_module(module(
            body, kind=0x7f, parameter_count=2))
        executor = WaveExecutor(decoded)

        for value, coordinate in ((0x80, 0), (0x40, 1), (1, 7),
                                  (0xa5, 3), (0xa5, 11)):
            with self.subTest(value=value, coordinate=coordinate):
                initial = start_state(decoded, 'f', (value, coordinate))
                plan = executor.plan(initial.frames[-1])
                self.assertEqual([node.op for node in plan.nodes],
                                 ['lane32.BIT_MSB8Z'])
                expected = 1 ^ ((value >> ((~coordinate) & 7)) & 1)
                self.assertEqual(executor.run(initial).result, (expected,))

    def test_dynamic_bit_field_is_one_physical_extract_lane(self):
        # (x >> offset) & ~(~0 << width) is the hardware bit-field observer.
        body = (b'\x00\x20\x00\x20\x01\x76'
                b'\x41\x7f\x20\x02\x74\x41\x7f\x73\x71\x0b')
        decoded = decode_module(module(
            body, kind=0x7f, parameter_count=3))
        executor = WaveExecutor(decoded)

        for value, offset, width in ((0x12345678, 4, 8), (0xffffffff, 7, 5),
                                     (17, 0, 0), (0xabcdef01, 31, 32)):
            with self.subTest(value=value, offset=offset, width=width):
                initial = start_state(decoded, 'f', (value, offset, width))
                plan = executor.plan(initial.frames[-1])
                self.assertEqual([node.op for node in plan.nodes],
                                 ['lane32.BEXTR'])
                count = width & 31
                expected = ((value & 0xffffffff) >> (offset & 31))
                expected &= (1 << count) - 1 if count else 0
                self.assertEqual(executor.run(initial).result, (expected,))

    def test_select_comparison_recomposes_as_unsigned_minimum(self):
        body = (b'\x00\x20\x00\x20\x01\x20\x00\x20\x01\x49\x1b\x0b')
        decoded = decode_module(module(
            body, kind=0x7f, parameter_count=2))
        executor = WaveExecutor(decoded)

        for left, right in ((0, 0), (1, 2), (7, 3),
                            (0xffffffff, 17)):
            with self.subTest(left=left, right=right):
                initial = start_state(decoded, 'f', (left, right))
                plan = executor.plan(initial.frames[-1])
                self.assertEqual([node.op for node in plan.nodes],
                                 ['lane32.UMIN'])
                self.assertEqual(executor.run(initial).result,
                                 (min(left, right),))

    def test_every_executed_page_uses_one_compiled_physical_transition(self):
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)

        first, _cost = executor.run_with_report(
            start_state(decoded, 'f', (9,)))
        self.assertEqual(sum(entry is not None
                             for entry in executor.steps.values()), 1)
        second, _cost = executor.run_with_report(
            start_state(decoded, 'f', (9,)))

        self.assertEqual(first.result, second.result)
        self.assertEqual(sum(entry is not None
                             for entry in executor.steps.values()), 1)
        self.assertEqual(
            executor.normalization_layout()['compiled_state_steps'], 1)

    def test_dead_slice_nodes_keep_trap_sensitive_operations(self):
        # The quotient is dropped, but x / x still traps for x == 0.
        body = b'\x00\x20\x00\x20\x00\x6e\x1a\x41\x07\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (0,))
        plan = executor.plan(initial.frames[-1])

        self.assertEqual(plan.waves.work, 1)
        with self.assertRaisesRegex(Exception, 'zero'):
            executor.step(initial)

    def test_slice_codec_is_segmented_mmap_data(self):
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (0x1234,))
        plan = WaveExecutor(decoded).plan(initial.frames[-1])

        blob = pack(plan)
        mapped = unpack(memoryview(blob))
        self.assertIs(mapped.data.obj, blob)
        self.assertEqual(mapped.wave(1), (1, 2))
        self.assertEqual(mapped.wave(2), (3,))
        self.assertEqual(mapped.layout()['slice_region'], [0, 7])
        self.assertEqual(mapped.layout()['wave_widths'], [2, 1])
        self.assertTrue(all(column['offset'] % 8 == 0
                            for column in mapped.layout()['columns'].values()))

        restored = decode_plan(mapped)
        self.assertEqual(restored.layout(), plan.layout())
        self.assertEqual(execute_slice(restored, initial),
                         execute_slice(plan, initial))
        self.assertEqual(execute_mapped(mapped, initial),
                         execute_slice(plan, initial))

    def test_slice_codec_rejects_a_second_encoding(self):
        body = b'\x00\x20\x00\x41\x01\x6a\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (2,))
        blob = bytearray(pack(WaveExecutor(decoded).plan(initial.frames[-1])))
        blob.extend(b'\0')
        with self.assertRaises(StatePageError):
            unpack(blob)

    def test_state_page_rejects_a_malformed_physical_lane(self):
        body = b'\x00\x20\x00\x42\x01\x7c\x42\x03\x7e\x42\x03\x7d\x0b'
        decoded = decode_module(module(body, kind=0x7e))
        initial = start_state(decoded, 'f', (2,))
        plan = WaveExecutor(decoded).plan(initial.frames[-1])
        blob = bytearray(pack(plan))
        mapped = unpack(blob)
        # IMUL has one SSA input followed by one constant.  Re-tag the
        # constant as a local coordinate while keeping the page in bounds.
        column = mapped.layout()['columns']['operand_tags']
        blob[column['offset'] + 1] = 2
        column = mapped.layout()['columns']['operand_values']
        blob[column['offset'] + 8:column['offset'] + 16] = bytes(8)
        with self.assertRaisesRegex(StatePageError,
                                   'mixes inputs and constants'):
            unpack(blob)

    def test_state_page_has_no_raw_wasm_operation_escape(self):
        body = b'\x00\x20\x00\x41\x01\x6a\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (2,))
        plan = WaveExecutor(decoded).plan(initial.frames[-1])
        raw = replace(
            plan,
            nodes=(replace(plan.nodes[0], op='i32.add'),) + plan.nodes[1:])

        with self.assertRaisesRegex(ValueError, 'no physical code'):
            pack(raw)
        with self.assertRaisesRegex(ValueError, 'physical lane operation'):
            execute_slice(raw, initial)

    def test_slice_codec_preserves_dropped_input_stack_extent(self):
        body = b'\x00\x1a\x1a\x41\x01\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (0,))
        frame = replace(initial.frames[-1], stack=(23, 41))
        plan = WaveExecutor(decoded).plan(frame)

        self.assertEqual(plan.stack_inputs, 2)
        self.assertEqual([(value.kind, value.value) for value in plan.stack],
                         [('const', 1)])
        self.assertEqual(unpack(pack(plan)).stack_inputs, 2)

    def test_state_page_carries_only_changed_local_coordinates(self):
        # One parameter plus 64 declared locals; only local 64 changes.
        body = (b'\x01\x40\x7f\x20\x00\x41\x01\x6a\x21\x40'
                b'\x3f\x00\x1a\x20\x00\x0b')
        decoded = decode_module(module(
            body, kind=0x7f, parameter_count=1, memory=True))
        initial = start_state(decoded, 'f', (7,))
        plan = WaveExecutor(decoded).plan(initial.frames[-1])
        mapped = unpack(pack(plan))

        self.assertEqual(mapped.local_extent, 65)
        self.assertEqual(mapped.local_updates, 1)
        self.assertEqual(mapped.values('local_indices'), (64,))
        self.assertEqual(mapped.layout()['columns']['local_values']['count'], 1)
        self.assertEqual(execute_mapped(mapped, initial),
                         execute_slice(plan, initial))

    def test_runtime_does_not_reconstruct_scalar_plan_from_physical_page(self):
        body = b'\x00\x20\x00\x41\x01\x6a\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        with patch('qm.steppage.decode_plan',
                   side_effect=AssertionError('diagnostic route used')):
            final = executor.run(start_state(decoded, 'f', (2,)))
        self.assertEqual(final.result, (3,))

    def test_executors_share_reached_physical_pages_not_runtime_counters(self):
        body = b'\x00\x20\x00\x41\x01\x6a\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (2,))
        first = WaveExecutor(decoded)
        first.run(initial)
        first_entry = next(first.steps.values())

        second = WaveExecutor(decoded)
        mapped = second.mapped(initial.frames[-1])
        second_entry = next(second.steps.values())
        self.assertIs(mapped, first_entry.mapped)
        self.assertIs(second_entry.execute, first_entry.execute)
        self.assertGreater(first_entry.executions, 0)
        self.assertEqual(second_entry.executions, 0)

        self.assertEqual(second.run(initial).result, (3,))
        self.assertGreater(second_entry.executions, 0)

    def test_local_writes_are_renamed_and_committed_at_slice_end(self):
        # local 1 = x + 1; return x * 2 + local 1.
        body = (b'\x01\x01\x7f\x20\x00\x41\x01\x6a\x21\x01'
                b'\x20\x00\x41\x02\x6c\x20\x01\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (7,))
        plan = executor.plan(initial.frames[-1])
        self.assertEqual(plan.waves.wave(1), (1, 2))
        self.assertEqual(plan.waves.wave(2), (3,))

        final, report = executor.run_with_report(initial)
        self.assertEqual(final.result, (22,))
        self.assertTrue(final.halted)
        self.assertEqual(report.barriers, 1)  # function end

    def test_only_observable_machine_operations_are_barriers(self):
        self.assertFalse(is_barrier('i32.load'))
        self.assertFalse(is_barrier('i64.store'))
        for op in ('call', 'call_indirect', 'br', 'br_if', 'br_table',
                   'return', 'if', 'loop', 'end', 'global.get',
                   'memory.grow'):
            with self.subTest(op=op):
                self.assertTrue(is_barrier(op))

    def test_default_runner_uses_the_wave_executor_without_changing_results(self):
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        final = run_until_boundary(decoded, start_state(decoded, 'f', (9,)))
        self.assertEqual(final.result, ((9 & 255) + (9 ^ 0x55),))

    def test_internal_control_and_memory_do_not_seal_full_state(self):
        # block { drop(load32(0)); } return 7. The load remains trap-sensitive
        # inside the physical cut, but no host can observe an intermediate
        # frame or memory version.
        body = (b'\x00\x02\x40\x41\x00\x28\x02\x00\x1a\x0b'
                b'\x41\x07\x0b')
        decoded = decode_module(module(body, kind=0x7f, memory=True))
        executor = WaveExecutor(decoded)
        final, report = executor.run_with_report(
            start_state(decoded, 'f', (0,)))

        self.assertEqual(final.result, (7,))
        self.assertGreater(report.slices + report.barriers, 2)
        layout = executor.normalization_layout()
        self.assertEqual(layout['state_materializations'], 2)
        self.assertEqual(
            layout['state_materializations']
            + layout['avoided_state_materializations'],
            report.slices + report.barriers)

    def test_stores_are_forwarded_in_byte_ssa_until_the_external_cut(self):
        # store32(0, 1); drop(load32(0)); store32(0, 2);
        # drop(load32(0)); return load32(0).  The second store invalidates the
        # old load, then the final load observes the new version.
        body = (b'\x00\x41\x00\x41\x01\x36\x02\x00'
                b'\x41\x00\x28\x02\x00\x1a'
                b'\x41\x00\x41\x02\x36\x02\x00'
                b'\x41\x00\x28\x02\x00\x1a'
                b'\x41\x00\x28\x02\x00\x0b')
        decoded = decode_module(module(body, kind=0x7f, memory=True))
        executor = WaveExecutor(decoded)
        final = executor.run(start_state(decoded, 'f', (0,)))

        self.assertEqual(final.result, (2,))
        self.assertEqual(decoded.memory.read(0, 4), bytes(4))
        self.assertEqual(final.memory.read(0, 4), b'\x02\x00\x00\x00')
        layout = executor.normalization_layout()
        self.assertEqual(layout['memory_ssa_stores'], 2)
        self.assertEqual(layout['memory_ssa_loads'], 0)
        self.assertEqual(layout['memory_ssa_load_bytes'], 0)
        self.assertEqual(layout['memory_ssa_store_bytes'], 8)
        self.assertEqual(layout['memory_final_store_bytes'], 4)
        self.assertEqual(layout['memory_store_segments'], 1)
        self.assertEqual(layout['memory_forwarded_loads'], 0)
        self.assertEqual(layout['memory_source_bytes_loaded'], 0)
        self.assertEqual(layout['qm_forwarded_memory_loads'], 3)
        self.assertEqual(layout['memory_state_materializations'], 1)
        self.assertEqual(layout['avoided_memory_state_materializations'], 1)
        self.assertEqual(layout['memory_pages_materialized'], 1)
        self.assertEqual(layout['memory_overwritten_bytes'], 4)

    def test_memory_c_loads_are_substituted_into_one_physical_cut(self):
        # Clang -O2 for corpus/physical-array/memory.c: store x+1, then load
        # the same dynamic coordinate twice and add the observations.
        body = (b'\x01\x01\x7f\x20\x00\x41\x07\x71\x41\x02\x74\x22\x01'
                b'\x20\x00\x41\x01\x6a\x36\x02\x80\x08'
                b'\x20\x01\x28\x02\x80\x08'
                b'\x20\x01\x28\x02\x80\x08\x6a\x0b')
        decoded = decode_module(module(
            body, kind=0x7f, parameter_count=1, memory=True))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (5,))
        plan = executor.plan(initial.frames[-1])

        self.assertEqual(plan.instructions, 15)
        self.assertEqual(plan.waves.work, 4)
        self.assertEqual(plan.waves.span, 2)
        self.assertEqual(sum(node.op.startswith('memory.')
                             and '.load' in node.op
                             for node in plan.nodes), 0)
        self.assertEqual(sum(node.op.startswith('memory.')
                             and '.store' in node.op
                             for node in plan.nodes), 1)

        final = executor.run(initial)
        self.assertEqual(final.result, (12,))
        self.assertEqual(final.memory.read(1024 + 5 * 4, 4),
                         b'\x06\x00\x00\x00')
        self.assertEqual(
            executor.normalization_layout()['qm_forwarded_memory_loads'], 2)

    def test_disjoint_constant_memory_ranges_share_one_wave(self):
        # Store [100,104), then load [200,204). Their source order carries no
        # memory dependence, so both physical operations occupy the same wave.
        body = (b'\x00\x41\xe4\x00\x41\x07\x36\x02\x00'
                b'\x41\xc8\x01\x28\x02\x00\x0b')
        decoded = decode_module(module(body, kind=0x7f, memory=True))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (0,))
        plan = executor.plan(initial.frames[-1])

        self.assertEqual(plan.waves.work, 2)
        self.assertEqual(plan.waves.span, 1)
        final = executor.run(initial)
        self.assertEqual(final.result, (0,))
        self.assertEqual(final.memory.read(100, 4), b'\x07\x00\x00\x00')

    def test_overlapping_memory_ranges_remain_ordered(self):
        body = (b'\x00\x41\xe4\x00\x41\x07\x36\x02\x00'
                b'\x41\xe4\x00\x28\x02\x00\x0b')
        decoded = decode_module(module(body, kind=0x7f, memory=True))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (0,))
        plan = executor.plan(initial.frames[-1])

        # The load is forwarded completely; retaining neither a load node nor
        # an artificial dependency is stronger than merely preserving span.
        self.assertEqual(plan.waves.work, 1)
        self.assertEqual(plan.waves.span, 1)
        self.assertEqual(executor.run(initial).result, (7,))

    def test_zero_observer_is_fused_into_a_memory_lane(self):
        body = b'\x00\x41\x00\x28\x02\x00\x45\x0b'
        decoded = decode_module(module(body, kind=0x7f, memory=True))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (0,))
        plan = executor.plan(initial.frames[-1])

        self.assertEqual(plan.waves.work, 1)
        self.assertEqual(plan.waves.span, 1)
        self.assertEqual(plan.nodes[0].op, 'memory.i32.load.eqz')
        self.assertEqual(executor.run(initial).result, (1,))

    def test_memory_bit_observer_is_one_lane_after_the_load(self):
        body = b'\x00\x41\x00\x2d\x00\x00\x41\x01\x71\x45\x0b'
        decoded = decode_module(module(body, kind=0x7f, memory=True))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (0,))
        plan = executor.plan(initial.frames[-1])

        self.assertEqual(plan.waves.work, 2)
        self.assertEqual(plan.waves.span, 2)
        self.assertEqual(plan.nodes[-1].op, 'lane32.BITZ')
        self.assertEqual(executor.run(initial).result, (1,))

    def test_shipped_vm_wasm_runs_through_pure_slices_and_barriers(self):
        with open('web/vm.wasm', 'rb') as handle:
            decoded = decode_module(handle.read())
        executor = WaveExecutor(decoded)
        final, report = executor.run_with_report(
            start_state(decoded, 'vm_load', (0,)))
        self.assertEqual(final.result, (0,))
        self.assertGreater(report.slices, 0)
        self.assertGreater(report.work, 0)
        self.assertGreater(report.barriers, 0)
        self.assertEqual(executor.total_cost, report)
        plans = [decode_plan(entry.mapped) for entry in executor.steps.values()
                 if entry is not None and entry.mapped.work]
        self.assertTrue(plans)
        self.assertTrue(all(
            node.op.startswith(('lane32.', 'lane64.', 'memory.'))
            for plan in plans for node in plan.nodes))
        self.assertGreaterEqual(
            executor.normalization_layout()['removed_work'], 1)
        self.assertNotIsInstance(executor.steps, dict)

    def test_state_frontend_supplies_zeroes_for_clang_style_entry_params(self):
        from qm.browser import stateful_wasm
        # Exported f(a, b) stands in for Clang's wasm main(argc, argv) ABI.
        body = b'\x00\x20\x00\x20\x01\x6a\x0b'
        raw = module(body, kind=0x7f, parameter_count=2)
        report = json.loads(stateful_wasm(
            base64.b64encode(raw).decode('ascii'), 'f',
            '{"state_max_states": 8}',
        ))
        self.assertTrue(report['ok'], report.get('error'))
        self.assertEqual(report['initial_observation'][2], [0])
        self.assertGreater(report['execution_layout']['pure_slices'], 0)
        self.assertIn('call', report['ordered_barriers'])


if __name__ == '__main__':
    unittest.main()
