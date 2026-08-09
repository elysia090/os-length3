"""Demand-mapped archive for sequence and WebAssembly wave pages."""

import unittest

from qm import isa
from qm.seqcodec import (execute, pack as pack_sequence, SequenceCodecError)
from qm.wasmcodec import pack as pack_wasm_slice
from qm.wasmstate import decode_module, start_state
from qm.wasmwave import WaveExecutor
from qm.wavearchive import ArchivePage, SEQUENCE, pack, unpack
from tests.test_wasmbinary import module


class TestWaveArchive(unittest.TestCase):
    def pages(self):
        seq = isa.Seq()
        deposited = seq.emit('PDEP', [0], const=0x0101010101010101)
        seq.emit('IMUL', [deposited], const=0x0101010101010100)
        sequence = ArchivePage('sequence', 7, 0, 1, pack_sequence(seq))

        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (0x1234,))
        plan = WaveExecutor(decoded).plan(initial.frames[-1])
        wasm_slice = ArchivePage(
            'wasm-slice', plan.function, plan.start, plan.stack_inputs,
            pack_wasm_slice(plan),
        )
        return sequence, wasm_slice

    def test_directory_order_is_canonical_and_pages_are_zero_copy(self):
        sequence, wasm_slice = self.pages()
        blob = pack([sequence, wasm_slice])
        self.assertEqual(blob, pack([wasm_slice, sequence]))

        mapped = unpack(memoryview(blob))
        self.assertIs(mapped.data.obj, blob)
        payload = mapped.page('sequence', 7)
        self.assertIs(payload.obj, blob)
        program = mapped.open('sequence', 7)
        self.assertEqual(program.layout()['span'], 2)
        self.assertEqual(execute(program, 5),
                         execute(mapped.open('sequence', 7), 5))

        slice_ = mapped.open('wasm-slice', 0, 0, 0)
        self.assertEqual(slice_.layout()['wave_widths'], [2, 1])
        self.assertEqual(mapped.layout()['pages'], 2)

    def test_a_cold_page_is_validated_only_when_opened(self):
        sequence, wasm_slice = self.pages()
        blob = bytearray(pack([sequence, wasm_slice]))
        mapped = unpack(blob)
        entry = mapped.entry('sequence', 7)
        blob[entry.offset] ^= 1

        remapped = unpack(blob)
        remapped.page('wasm-slice', 0, 0, 0)
        with self.assertRaises(SequenceCodecError):
            remapped.open('sequence', 7)

    def test_the_resident_directory_needs_no_hash_index(self):
        mapped = unpack(pack(self.pages()))
        self.assertFalse(hasattr(mapped, '_by_key'))
        self.assertEqual(mapped.entry('sequence', 7).kind, SEQUENCE)
        with self.assertRaisesRegex(KeyError, 'not in the archive'):
            mapped.entry('sequence', 99)


if __name__ == '__main__':
    unittest.main()
