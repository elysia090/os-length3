"""Independent compressed spans for immutable physical memory."""

import unittest

from qm.memoryarchive import MemoryArchiveError, pack, unpack
from qm.wasmstate import PagedMemory


class TestMemoryArchive(unittest.TestCase):
    def memory(self):
        memory = PagedMemory(b'', 3 << 16)
        memory = memory.write(7, b'first')
        memory = memory.write((2 << 16) + 300, b'last')
        return memory

    def test_directory_maps_spans_before_payloads_are_decoded(self):
        memory = self.memory()
        payload = pack(memory)
        mapped = unpack(memoryview(payload))

        self.assertIs(mapped.data.obj, payload)
        self.assertEqual(mapped.layout()['spans'], 2)
        self.assertEqual(mapped.page(0), memory.read(0, 256))
        self.assertEqual(mapped.layout()['resident_spans'], 1)
        self.assertEqual(mapped.page(256), bytes(256))
        self.assertEqual(mapped.layout()['resident_spans'], 1)
        self.assertEqual(mapped.materialize(), memory)

        lazy = unpack(payload).paged_memory()
        self.assertEqual(lazy.read(7, 5), b'first')
        self.assertEqual(lazy._backing.layout()['resident_spans'], 1)
        changed = lazy.write((2 << 16) + 300, b'new')
        self.assertIs(changed._backing, lazy._backing)
        self.assertEqual(changed.read((2 << 16) + 300, 3), b'new')

    def test_each_span_has_an_independent_integrity_check(self):
        payload = bytearray(pack(self.memory()))
        mapped = unpack(payload)
        entry = mapped.entries[-1]
        payload[entry.offset] ^= 1

        remapped = unpack(payload)
        self.assertEqual(remapped.page(0)[:12], self.memory().read(0, 12))
        with self.assertRaises(MemoryArchiveError):
            remapped.span(entry.index)

    def test_nonempty_linear_base_is_not_silently_duplicated(self):
        with self.assertRaisesRegex(ValueError, 'implicit-zero'):
            pack(PagedMemory(b'base'))


if __name__ == '__main__':
    unittest.main()
