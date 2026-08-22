"""WebAssembly code has compact sequential and grouped physical views."""

import unittest

from qm import isa
from qm.laneops import (bind, evaluate, x86_bit_summary_results,
                        x86_bzhi_results,
                        x86_divide_results,
                        x86_double_shift_results,
                        x86_crc32_value,
                        x86_rotate_carry_results)
from qm.wasmphysical import (frame_coordinate, lower_module,
                             memory_coordinate, schedule_sequence,
                             summarize_binary)
from qm.wasmbinary import encode_uleb
from qm.wasmstate import decode_module, start_state
from qm.wasmwave import WaveExecutor
from tests.test_wasmbinary import module, section


class TestPhysicalWasmLayout(unittest.TestCase):
    def setUp(self):
        # get 0; const 3; add; const 4; add; end
        raw = module(b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        self.physical = lower_module(decode_module(raw))

    def test_function_pc_is_one_segmented_dense_rank(self):
        domain = self.physical.domain
        self.assertEqual(domain.rank(0, 0), 0)
        self.assertEqual(domain.select(3), (0, 3))
        self.assertEqual(domain.fallthrough(3), 4)
        self.assertEqual(domain.fallthrough(domain.instructions - 1), -1)

    def test_opcode_groups_are_an_invertible_view(self):
        groups = self.physical.groups
        self.assertEqual(groups.span('i64.add'), (2, 4))
        for rank, position in enumerate(groups.position):
            self.assertEqual(groups.ranks[position], rank)

    def test_immediates_are_one_packed_column(self):
        self.assertEqual(self.physical.instruction(0, 1), ('i64.const', (3,)))
        self.assertEqual(self.physical.instruction(0, 3), ('i64.const', (4,)))
        layout = self.physical.layout()
        self.assertEqual(layout['next_coordinate_storage'], 0)
        self.assertEqual(layout['instructions'], 6)

    def test_runtime_coordinates_are_affine_or_page_split(self):
        self.assertEqual(frame_coordinate(100, 7), 107)
        self.assertEqual(memory_coordinate(0x12345), (0x123, 0x45))

    def test_large_binary_summary_does_not_store_fallthrough_edges(self):
        raw = module(b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        report = summarize_binary(raw)
        self.assertEqual(report['decoded_functions'], 1)
        self.assertEqual(report['instructions'], 6)
        self.assertEqual(report['derived_next_coordinates'], 5)
        self.assertEqual(report['next_coordinate_storage'], 0)
        self.assertEqual(report['grammar_pure_instructions'], 5)
        self.assertEqual(report['grammar_barrier_instructions'], 1)
        self.assertEqual(report['barrier_groups'], {'end': 1})

    def test_independent_ssa_writes_share_one_parallel_wave(self):
        sequence = isa.Seq()
        left = sequence.emit('AND', [0], const=0xff)
        right = sequence.emit('XOR', [0], const=0x55)
        sequence.result = sequence.emit('ADDR', [left, right])
        waves = schedule_sequence(sequence)
        self.assertEqual(waves.wave(1), (1, 2))
        self.assertEqual(waves.wave(2), (3,))
        self.assertEqual(waves.layout(), {
            'kind': 'dependency-waves',
            'work': 3,
            'span': 2,
            'wave_widths': [2, 1],
            'max_parallel_width': 2,
        })

    def test_function_bodies_and_coordinate_rows_are_demand_materialized(self):
        function_type = b'\x01\x60\x00\x01\x7f'
        functions = b'\x02\x00\x00'
        exports = b'\x01\x01f\x00\x00'
        first = b'\x00\x41\x01\x0b'
        second = b'\x00\x41\x02\x0b'
        code = (b'\x02' + encode_uleb(len(first)) + first
                + encode_uleb(len(second)) + second)
        raw = (b'\x00asm\x01\x00\x00\x00'
               + section(1, function_type) + section(3, functions)
               + section(7, exports) + section(10, code))

        decoded = decode_module(raw)
        executor = WaveExecutor(decoded)

        self.assertEqual(decoded.code_layout()['decoded_functions'], 0)
        self.assertEqual(executor.steps.resident_rows, 0)

        state = start_state(decoded, 'f')
        self.assertEqual(decoded.code_layout()['decoded_functions'], 1)
        self.assertFalse(decoded.functions[1].decoded)

        executor.mapped(state.frames[-1])
        self.assertEqual(executor.steps.resident_rows, 1)
        self.assertFalse(decoded.functions[1].decoded)


class TestBoundPhysicalLanes(unittest.TestCase):
    def test_x86_bzhi_is_one_flags_and_result_observation(self):
        prior = 0xad7
        cases = (
            ((prior, 0xf0, 4, 64), (0x256, 0)),
            ((prior, 0x81, 8, 32), (0x216, 0x81)),
            ((prior, 0x80000000, 31, 32), (0x256, 0)),
            ((prior, 0x80000001, 32, 32), (0x293, 0x80000001)),
            ((prior, 0x8000000000000001, 0x140, 64),
             (0x293, 0x8000000000000001)),
        )
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                self.assertEqual(x86_bzhi_results(arguments), expected)
                self.assertEqual(
                    evaluate('lane64.X86_BZHI', arguments), expected[0])

    def test_x86_crc32_lane_matches_the_crc32c_check_vector(self):
        crc = 0xffffffff
        for value in b'123456789':
            crc = x86_crc32_value((crc, value, 8))
        self.assertEqual(crc ^ 0xffffffff, 0xe3069283)
        first = int.from_bytes(b'12345678', 'little')
        wide = x86_crc32_value((0xffffffff, first, 64))
        sequential = 0xffffffff
        for value in b'12345678':
            sequential = x86_crc32_value((sequential, value, 8))
        self.assertEqual(wide, sequential)
        self.assertEqual(
            evaluate('lane64.X86_CRC32', (0xffffffff, first, 64)), wide)

    def test_x86_double_shift_is_one_restartable_flags_result_lane(self):
        prior = 0x246
        cases = (
            ((prior, 0x8000000000000001, 3, 1, 64),
             (0xa03, 2, 1)),
            ((prior, 1, 1, 1, 64 | (1 << 8)),
             (0xa87, 0x8000000000000000, 1)),
            ((prior, 0x1234, 0xabcd, 0, 16), (prior, 0x1234, 0)),
            ((prior, 0x1234, 0xabcd, 16, 16),
             (0x282, 0xabcd, 1)),
        )
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                self.assertEqual(x86_double_shift_results(arguments), expected)
                self.assertEqual(
                    evaluate('lane64.X86_DOUBLE_SHIFT', arguments), expected[0])

    def test_x86_bit_summary_is_one_flags_and_result_observation(self):
        prior = 0xad7
        cases = (
            ((prior, 0x10, 64 | (0 << 8)), (prior & ~(1 << 6) | 2, 4)),
            ((prior, 0x10, 64 | (1 << 8)), (prior & ~(1 << 6) | 2, 4)),
            ((prior, 0, 32 | (2 << 8)),
             (((prior & ~0x41) | 1 | 2), 32)),
            ((prior, 1, 16 | (3 << 8)),
             (((prior & ~0x41) | 2), 15)),
            ((prior, 0xf0f0, 16 | (4 << 8)),
             (((prior & ~0x8d5) | 2), 8)),
            ((prior, 0, 64 | (4 << 8)),
             (((prior & ~0x8d5) | (1 << 6) | 2), 0)),
        )
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                self.assertEqual(x86_bit_summary_results(arguments), expected)
                self.assertEqual(
                    evaluate('lane64.X86_BIT_SUMMARY', arguments), expected[0])

    def test_x86_divide_is_one_atomic_double_width_result(self):
        cases = (
            ((0, 85, 4, 64), (0, 21, 1)),
            ((0, 1, 0, 64), (1, 0, 0)),
            ((1, 0, 1, 8), (1, 0, 0)),
            ((0, 0x55, 4, 8), (0, 21, 1)),
            (((1 << 64) - 1, (1 << 64) - 85, (1 << 64) - 4,
              64 | (1 << 8)), (0, 21, (1 << 64) - 1)),
        )
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                self.assertEqual(x86_divide_results(arguments), expected)
                self.assertEqual(
                    evaluate('lane64.X86_DIVIDE', arguments), expected[0])

    def test_x86_rotate_carry_closed_form_matches_the_width_plus_carry_ring(self):
        for width in (8, 16, 32, 64):
            lane_mask = (1 << width) - 1
            ring_mask = (1 << (width + 1)) - 1
            for right in (0, 1):
                for prior in (2, 3, 0x802, 0x8d7):
                    for source in (0, 1, lane_mask, 1 << (width - 1),
                                   0x9d & lane_mask):
                        for raw_amount in range(71):
                            amount = raw_amount & (63 if width == 64 else 31)
                            if width < 32:
                                amount %= width + 1
                            ring = (source & lane_mask) | ((prior & 1) << width)
                            if amount:
                                if right:
                                    ring = ((ring >> amount)
                                            | (ring << (width + 1 - amount)))
                                else:
                                    ring = ((ring << amount)
                                            | (ring >> (width + 1 - amount)))
                                ring &= ring_mask
                            value = ring & lane_mask
                            if not amount:
                                flags = prior
                            else:
                                carry = (ring >> width) & 1
                                if right:
                                    overflow = ((value >> (width - 1))
                                                ^ (value >> (width - 2))) & 1
                                else:
                                    overflow = ((value >> (width - 1))
                                                ^ carry) & 1
                                if amount != 1:
                                    overflow = 0
                                flags = ((prior & ~((1 << 11) | 1)) | carry
                                         | (overflow << 11) | 2)
                            arguments = (
                                prior, source, raw_amount,
                                width | (right << 8),
                            )
                            with self.subTest(arguments=arguments):
                                self.assertEqual(
                                    x86_rotate_carry_results(arguments),
                                    (flags, value, int(bool(amount))))
                                self.assertEqual(
                                    evaluate('lane64.X86_ROTATE_CARRY',
                                             arguments), flags)

    def test_bound_hot_lanes_match_the_reference_interpreter(self):
        cases = {
            'lane32.ADD': (0xffffffff, 2),
            'lane64.SUB': (0, 3),
            'lane32.IMUL': (0x80000001, 7),
            'lane32.AND': (0xabcdef01, 0xff00ff00),
            'lane64.OR': (0x100, 3),
            'lane32.XOR': (0x55, 0xff),
            'lane32.NOT': (0x12345678,),
            'lane64.NEG': (7,),
            'lane32.SHL': (0x80000001, 3),
            'lane64.SHR': (1 << 63, 17),
            'lane32.SAR': (0x80000000, 5),
            'lane64.SCANXOR': (0x1234, 9),
            'lane32.CLZ': (0x100,),
            'lane64.CTZ': (0x1000,),
            'lane32.POPCNT': (0xf0f0f0f0,),
            'lane32.ADDR': (0xffffffff, 9),
            'lane64.SUBR': (3, 9),
            'lane32.ANDR': (0xf0, 0x3c),
            'lane64.ORR': (0x100, 7),
            'lane32.XORR': (0xaa, 0xff),
            'lane64.ANDNR': (0xf0, 0x1ff),
            'lane64.SELECT': (11, 29, 0),
            'lane32.WRAP_I64': (0x123456789,),
            'lane64.EXTEND_I32_U': (0xffffffff,),
            'lane64.EXTEND_I32_S': (0x80000000,),
            'lane32.EXTEND8_S': (0x80,),
            'lane64.EXTEND32_S': (0x80000000,),
            'lane32.EQZ': (0,),
            'lane64.EQ': (7, 7),
            'lane32.NE': (7, 9),
            'lane64.LT_U': (3, 9),
            'lane32.GT_U': (9, 3),
            'lane64.LE_U': (9, 9),
            'lane32.GE_U': (9, 3),
            'lane64.LT_S': ((1 << 64) - 1, 0),
            'lane32.GT_S': (1, 0xffffffff),
            'lane64.LE_S': ((1 << 63), 0),
            'lane32.GE_S': (0xffffffff, 0xffffffff),
            'lane64.MULR': (0x1234, 0x5678),
            'lane32.SHLR': (0x80000001, 35),
            'lane64.SHRR': (1 << 63, 67),
            'lane32.SARR': (0x80000000, 37),
            'lane64.ROTL': (0x8000000000000001, 17),
            'lane32.ROTR': (0x80000001, 9),
            'lane64.BIT': (0x100, 8),
            'lane32.BITZ': (0, 7),
            'lane64.BIT_MSB8': (0x80, 0),
            'lane32.BIT_MSB8Z': (0, 0),
            'lane64.ADD3': (0xffffffffffffffff, 2, 3),
            'lane32.BEXTR': (0xabcdef01, 4, 12),
            'lane64.UMIN': (9, 3),
            'lane32.UMAX': (9, 3),
            'lane64.SMIN': ((1 << 64) - 1, 3),
            'lane32.SMAX': (0xffffffff, 3),
            # Uncommon/trapping operations retain the reference route.
            'lane32.DIV_U': (17, 5),
            'lane64.PDEP': (7, 0x0101010101010101),
        }
        for operation, arguments in cases.items():
            with self.subTest(operation=operation):
                self.assertEqual(bind(operation)(arguments),
                                 evaluate(operation, arguments))

if __name__ == '__main__':
    unittest.main()
