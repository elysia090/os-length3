"""Physical byte-coordinate normalization between observable state cuts."""

import unittest

from qm.memorycut import BytePage, MemoryCut
from qm.wasmstate import PagedMemory


class CountingMemory(PagedMemory):
    __slots__ = ('page_reads',)

    def __init__(self, base):
        super().__init__(base)
        self.page_reads = 0

    def _page(self, index):
        self.page_reads += 1
        return super()._page(index)


class TestMemoryCut(unittest.TestCase):
    def test_a_dominating_store_hides_the_source_page(self):
        source = PagedMemory(bytes(range(256)))
        cut = MemoryCut(source)
        cut.write(40, b'qm!!')

        self.assertEqual(cut.load(40, 4), int.from_bytes(b'qm!!', 'little'))
        self.assertEqual(cut.forwarded_loads, 1)
        self.assertEqual(cut.source_bytes_loaded, 0)
        self.assertEqual(cut.final_store_bytes, 4)
        self.assertEqual(cut.store_segments, 1)

    def test_a_partial_store_merges_only_missing_source_coordinates(self):
        source = PagedMemory(bytes(range(256)))
        cut = MemoryCut(source)
        cut.write(41, b'XY')

        self.assertEqual(cut.read(40, 4), bytes((40, 88, 89, 43)))
        self.assertEqual(cut.source_bytes_loaded, 2)
        self.assertEqual(cut.final_store_bytes, 2)
        self.assertEqual(cut.store_segments, 1)

    def test_adjacent_writes_form_one_segment_and_overwrites_disappear(self):
        source = PagedMemory(bytes(256))
        cut = MemoryCut(source)
        cut.write(8, b'ab')
        cut.write(10, b'cd')
        cut.write(9, b'XYZ')

        self.assertEqual(cut.store_bytes, 7)
        self.assertEqual(cut.overwritten_bytes, 3)
        self.assertEqual(cut.final_store_bytes, 4)
        self.assertEqual(cut.store_segments, 1)
        self.assertEqual(cut.commit().read(8, 4), b'aXYZ')

    def test_mask_boundaries_are_maximal_parallel_segments(self):
        page = BytePage()
        page.write(1, b'ab')
        page.write(5, b'cde')
        page.write(7, b'f')

        self.assertEqual(tuple(page._runs(page.written)), ((1, 3), (5, 8)))
        self.assertEqual(page.segments, 2)

    def test_a_complete_page_commit_does_not_observe_the_source_page(self):
        source = CountingMemory(bytes(range(256)))
        cut = MemoryCut(source)
        cut.write(0, bytes(reversed(range(256))))

        result = cut.commit()

        self.assertEqual(source.page_reads, 0)
        self.assertEqual(result.read(0, 256), bytes(reversed(range(256))))


if __name__ == '__main__':
    unittest.main()
