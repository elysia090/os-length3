"""WebAssembly code has compact sequential and grouped physical views."""

import unittest

from qm import isa
from qm.wasmphysical import (frame_coordinate, lower_module,
                             memory_coordinate, schedule_sequence,
                             summarize_binary)
from qm.wasmstate import decode_module
from tests.test_wasmbinary import module


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


if __name__ == '__main__':
    unittest.main()
