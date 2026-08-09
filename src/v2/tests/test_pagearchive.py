"""Demand-mapped archive for scalar and state-step pages."""

import unittest

from qm import isa
from qm.scalarpage import (execute, pack as pack_scalar, ScalarPageError)
from qm.steppage import pack as pack_state_step
from qm.wasmstate import decode_module, start_state
from qm.wasmwave import WaveExecutor
from qm.pagearchive import ArchivePage, SCALAR, pack, unpack
from tests.test_wasmbinary import module


class TestPageArchive(unittest.TestCase):
    def pages(self):
        seq = isa.Seq()
        deposited = seq.emit('PDEP', [0], const=0x0101010101010101)
        seq.emit('IMUL', [deposited], const=0x0101010101010100)
        scalar = ArchivePage('scalar', 7, 0, 1, pack_scalar(seq))

        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (0x1234,))
        plan = WaveExecutor(decoded).plan(initial.frames[-1])
        state_step = ArchivePage(
            'state-step', plan.function, plan.start, plan.stack_inputs,
            pack_state_step(plan),
        )
        return scalar, state_step

    def test_directory_order_is_canonical_and_pages_are_zero_copy(self):
        scalar, state_step = self.pages()
        blob = pack([scalar, state_step])
        self.assertEqual(blob, pack([state_step, scalar]))

        mapped = unpack(memoryview(blob))
        self.assertIs(mapped.data.obj, blob)
        payload = mapped.page('scalar', 7)
        self.assertIs(payload.obj, blob)
        program = mapped.open('scalar', 7)
        self.assertEqual(program.layout()['span'], 2)
        self.assertEqual(execute(program, 5),
                         execute(mapped.open('scalar', 7), 5))

        slice_ = mapped.open('state-step', 0, 0, 0)
        self.assertEqual(slice_.layout()['wave_widths'], [2, 1])
        self.assertEqual(mapped.layout()['pages'], 2)

    def test_a_cold_page_is_validated_only_when_opened(self):
        scalar, state_step = self.pages()
        blob = bytearray(pack([scalar, state_step]))
        mapped = unpack(blob)
        entry = mapped.entry('scalar', 7)
        blob[entry.offset] ^= 1

        remapped = unpack(blob)
        remapped.page('state-step', 0, 0, 0)
        with self.assertRaises(ScalarPageError):
            remapped.open('scalar', 7)

    def test_the_resident_directory_needs_no_hash_index(self):
        mapped = unpack(pack(self.pages()))
        self.assertFalse(hasattr(mapped, '_by_key'))
        self.assertEqual(mapped.entry('scalar', 7).kind, SCALAR)
        with self.assertRaisesRegex(KeyError, 'not in the archive'):
            mapped.entry('scalar', 99)


if __name__ == '__main__':
    unittest.main()
