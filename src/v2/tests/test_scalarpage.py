"""Physical page for QM's normalized scalar SSA programs."""

import unittest

from qm import isa
from qm.bits import clmul, pdep
from qm.scalarpage import execute, pack, unpack, ScalarPageError


ONES = 0x0101010101010101


class TestSequenceCodec(unittest.TestCase):
    def test_ranks8_keeps_pdep_and_imul_as_two_physical_waves(self):
        seq = isa.Seq()
        deposited = seq.emit('PDEP', [0], const=ONES)
        seq.emit('IMUL', [deposited], const=0x0101010101010100)

        blob = pack(seq)
        mapped = unpack(memoryview(blob))
        self.assertIs(mapped.data.obj, blob)
        self.assertEqual(mapped.layout()['wave_widths'], [1, 1])
        self.assertEqual(mapped.layout()['span'], 2)
        self.assertEqual(mapped.layout()['work'], 2)
        for mask in range(256):
            expected = (pdep(mask, ONES) * 0x0101010101010100) & ((1 << 64) - 1)
            self.assertEqual(execute(mapped, mask), expected)

    def test_independent_consumers_share_a_wave(self):
        seq = isa.Seq()
        deposited = seq.emit('PDEP', [0], const=ONES)
        ranks = seq.emit('IMUL', [deposited],
                         const=0x0101010101010100)
        mask = seq.emit('IMUL', [deposited], const=0xff)
        seq.emit('XORR', [ranks, mask])

        mapped = unpack(pack(seq))
        self.assertEqual(mapped.layout()['wave_widths'], [1, 2, 1])
        self.assertEqual(mapped.wave(2), (2, 3))

    def test_prefix_xor_is_one_clmul_lane(self):
        seq = isa.Seq()
        seq.emit('CLMUL', [0], const=(1 << 64) - 1)
        mapped = unpack(pack(seq))

        self.assertEqual(mapped.layout()['span'], 1)
        self.assertEqual(mapped.layout()['work'], 1)
        for value in (0, 1, 3, 0x123456789abcdef0, (1 << 64) - 1):
            self.assertEqual(execute(mapped, value),
                             clmul(value, (1 << 64) - 1, 64)
                             & ((1 << 64) - 1))

    def test_residual_query_binary_lanes_round_trip(self):
        seq = isa.Seq()
        selected = seq.emit('SHRR', [0, 0])
        seq.emit('GT_U', [selected, 0])
        mapped = unpack(pack(seq))

        self.assertEqual(mapped.layout()['work'], 2)
        for value in (0, 1, 3, 0x80, 0x1234):
            selected = value >> (value & 63)
            self.assertEqual(execute(mapped, value),
                             int(selected > value))

    def test_noncanonical_trailing_data_is_rejected(self):
        seq = isa.Seq()
        seq.emit('IMUL', [0], const=ONES)
        blob = bytearray(pack(seq))
        blob.append(0)
        with self.assertRaises(ScalarPageError):
            unpack(blob)

if __name__ == '__main__':
    unittest.main()
