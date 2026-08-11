"""Physical byte-coordinate normalization between observable state cuts."""

import unittest

from qm.memorycut import BytePage, MemoryCut
from qm.wasmstate import CanonicalPage, PagedMemory


class CountingMemory(PagedMemory):
    __slots__ = ('page_reads', 'slice_bytes', 'base_slice_bytes')

    def __init__(self, base):
        super().__init__(base)
        self.page_reads = 0
        self.slice_bytes = 0
        self.base_slice_bytes = 0

    def _page(self, index):
        self.page_reads += 1
        return super()._page(index)

    def _page_slice(self, index, offset, count):
        self.slice_bytes += count
        return super()._page_slice(index, offset, count)

    def _base_page_slice(self, index, offset, count):
        self.base_slice_bytes += count
        return super()._base_page_slice(index, offset, count)


class TestMemoryCut(unittest.TestCase):
    def test_aligned_copy_retains_the_canonical_source_page(self):
        source = PagedMemory(b'', 512).write(0, b'A' * 256)
        cut = MemoryCut(source)

        result = cut.copy(0, 256, 256).commit()

        self.assertEqual(result.read(256, 256), b'A' * 256)
        self.assertIs(result._page(256 // 256), source._page(0))
        self.assertEqual(cut.aliased_pages, 1)
        self.assertEqual(cut.materialized_pages, 0)

    def test_zero_fill_skips_an_unchanged_implicit_page(self):
        source = PagedMemory(b'', 512)
        cut = MemoryCut(source)

        result = cut.fill(256, 256, 0).commit()

        self.assertIs(result, source)
        self.assertEqual(cut.elided_pages, 1)
        self.assertEqual(cut.dirty, [])

    def test_repeated_pattern_keeps_full_pages_physical(self):
        source = PagedMemory(b'', 768)
        cut = MemoryCut(source)

        result = cut.repeat(1, 511, b'AB').commit()

        self.assertEqual(result.read(0, 512), b'\0' + b'AB' * 255 + b'A')
        self.assertEqual(cut.aliased_pages, 1)

    def test_a_dominating_store_hides_the_source_page(self):
        source = PagedMemory(bytes(range(256)))
        cut = MemoryCut(source)
        cut.write(40, b'qm!!')

        self.assertEqual(cut.load(40, 4), int.from_bytes(b'qm!!', 'little'))
        self.assertEqual(cut.forwarded_loads, 1)
        self.assertEqual(cut.source_bytes_loaded, 0)
        self.assertEqual(cut.final_store_bytes, 4)
        self.assertEqual(cut.store_segments, 1)

    def test_a_source_load_does_not_materialize_the_rest_of_its_page(self):
        source = CountingMemory(bytes(range(256)))
        cut = MemoryCut(source)

        self.assertEqual(cut.load(40, 8),
                         int.from_bytes(bytes(range(40, 48)), 'little'))
        self.assertEqual(source.page_reads, 0)
        self.assertEqual(source.slice_bytes, 8)

    def test_direct_find_observes_nothing_after_the_first_coordinate(self):
        source = CountingMemory(b'ordinary text\0unobserved')
        cut = MemoryCut(source)

        coordinate = cut.find(0, len(source), (0,))

        self.assertEqual(coordinate, 13)
        self.assertEqual(cut.source_bytes_loaded, 14)
        self.assertEqual(cut.load_bytes, 14)
        self.assertEqual(source.page_reads, 0)
        self.assertEqual(source.slice_bytes, 0)

    def test_direct_find_uses_newest_byte_coordinates(self):
        source = CountingMemory(b'ab\0defgh')
        cut = MemoryCut(source)
        cut.write(2, b'c')
        cut.write(5, b'\0')

        coordinate = cut.find(0, len(source), (0,))

        self.assertEqual(coordinate, 5)
        self.assertEqual(cut.source_bytes_loaded, 4)
        self.assertEqual(source.slice_bytes, 0)

    def test_complement_find_observes_only_through_the_first_difference(self):
        source = CountingMemory(b'aaaaZunobserved')
        cut = MemoryCut(source)

        coordinate = cut.find_not(0, len(source), ord('a'))

        self.assertEqual(coordinate, 4)
        self.assertEqual(cut.source_bytes_loaded, 5)
        self.assertEqual(cut.load_bytes, 5)
        self.assertEqual(source.page_reads, 0)
        self.assertEqual(source.slice_bytes, 0)

    def test_complement_find_uses_newest_byte_coordinates(self):
        source = CountingMemory(b'aaZaaaa')
        cut = MemoryCut(source)
        cut.write(2, b'a')
        cut.write(5, b'Q')

        coordinate = cut.find_not(0, len(source), ord('a'))

        self.assertEqual(coordinate, 5)
        self.assertEqual(cut.source_bytes_loaded, 4)
        self.assertEqual(source.slice_bytes, 0)

    def test_a_partial_store_merges_only_missing_source_coordinates(self):
        source = CountingMemory(bytes(range(256)))
        cut = MemoryCut(source)
        cut.write(41, b'XY')

        self.assertEqual(cut.read(40, 4), bytes((40, 88, 89, 43)))
        self.assertEqual(cut.source_bytes_loaded, 2)
        self.assertEqual(source.slice_bytes, 2)
        self.assertEqual(cut.final_store_bytes, 2)
        self.assertEqual(cut.store_segments, 1)

    def test_sparse_commit_publishes_only_the_difference_coordinates(self):
        source = CountingMemory(bytes(range(256)))
        cut = MemoryCut(source)
        cut.write(40, b'X')

        result = cut.commit()
        page = result._page_entry(0)

        self.assertIsInstance(page, CanonicalPage)
        self.assertEqual(page.domain, 1 << 40)
        self.assertEqual(page.values, b'X')
        self.assertIs(page._slots, False)
        self.assertEqual(page.slots[40], 1)
        self.assertIsInstance(page._slots, bytes)
        self.assertEqual(result.evict_direct_caches(), 1)
        self.assertIs(page._slots, False)
        self.assertEqual(source.base_slice_bytes, 1)
        self.assertEqual(source.page_reads, 0)
        self.assertEqual(result.read(39, 3), bytes((39, 88, 41)))

    def test_idempotent_dirty_write_reuses_the_persistent_page(self):
        first = MemoryCut(PagedMemory(bytes(range(256))))
        first.write(40, b'X')
        memory = first.commit()
        retained = memory._page_entry(0)

        second = MemoryCut(memory)
        second.write(40, b'X')
        again = second.commit()

        self.assertIs(again, memory)
        self.assertIs(again._page_entry(0), retained)

    def test_direct_slots_equal_stable_dense_rank_for_every_mask(self):
        domains = list(range(1, 256))
        domains += [1 << coordinate for coordinate in range(256)]
        domains += [(1 << count) - 1 for count in range(1, 256)]
        domains += [int.from_bytes(bytes((mask,)) * 32, 'little')
                    for mask in range(1, 255)]
        for domain in domains:
            page = CanonicalPage(domain, bytes(range(domain.bit_count())))
            before = 0
            for coordinate in range(256):
                expected = before + 1 if domain & (1 << coordinate) else 0
                self.assertEqual(page.slots[coordinate], expected)
                before += bool(domain & (1 << coordinate))
        full = CanonicalPage((1 << 256) - 1, bytes(256))
        self.assertIsNone(full.slots)

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

    def test_affine_byte_updates_join_before_the_physical_page_cut(self):
        source = CountingMemory(bytes(range(256)) * 2)
        cut = MemoryCut(source)

        cut.increment_bytes(((3, 1), (260, 2), (3, 4), (260, 1)))
        first_revision = cut.change_revision
        cut.increment_bytes(((3, 251), (4, 1)))

        result = cut.commit()
        self.assertEqual(result.read(3, 2), bytes((3, 5)))
        self.assertEqual(result.read(260, 1), bytes((7,)))
        self.assertEqual(source.slice_bytes, 3)
        self.assertEqual(first_revision, 2)
        self.assertEqual(cut.change_revision, 3)
        self.assertEqual(cut.final_store_bytes, 3)

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

    def test_proof_only_invalidates_the_written_byte_coordinates(self):
        source = PagedMemory(bytes(256))
        cut = MemoryCut(source)
        original = source.proof_token(0, 0, 8)
        cut.write(128, b'changed')

        retained = cut.proof_token(0, 0, 8)

        self.assertIs(retained[0], original[0])
        self.assertEqual(retained[1], original[1])
        changed = cut.proof_token(0, 128, 7)
        cut.write(130, b'xx')
        changed_again = cut.proof_token(0, 128, 7)
        self.assertIs(changed_again[0], changed[0])
        self.assertNotEqual(changed_again[1], changed[1])

    def test_page_change_revision_reports_only_later_writes(self):
        cut = MemoryCut(PagedMemory(bytes(512)))
        cut.write(1, b'a')
        revision, pages = cut.changed_pages_since(0)
        self.assertEqual(tuple(pages), (0,))

        cut.write(300, b'b')
        current, pages = cut.changed_pages_since(revision)

        self.assertEqual(tuple(pages), (1,))
        self.assertEqual(current, 2)
        self.assertEqual(cut.change_revision, current)


if __name__ == '__main__':
    unittest.main()
