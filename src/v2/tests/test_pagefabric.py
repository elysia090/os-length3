"""Four-layer direct-page delivery and recovery."""

import unittest
import struct
import hashlib

from kernel.pagefabric import (MemoryShardStore, PageFabric,
                               PageFabricError, dump_bundle, dump_manifest,
                               bundle_prefix_size, load_bundle, load_manifest,
                               load_range_bundle, project,
                               project_sparse, SubpageBacking,
                               build_ciphertext_row_directory,
                               build_erasure_recovery_directory,
                               CiphertextDirectory, CiphertextGroup,
                               CiphertextRankRecord,
                               dump_ciphertext_directory,
                               load_ciphertext_directory,
                               decode_ciphertext_frame,
                               encode_ciphertext_frame,
                               encode_ciphertext_row_aad,
                               opaque_row_locator,
                               stored_row_authenticator,
                               _combine, _generator)


class TestPageFabric(unittest.TestCase):
    def object(self):
        pages = [b'A' * 64, bytes(64), b'B' * 64, b'A' * 64,
                 b'C' * 64, b'D' * 64, b'E' * 64]
        return b''.join(pages) + b'tail'

    def test_ciphertext_rows_are_a_stable_direct_csr_bijection(self):
        directory = build_ciphertext_row_directory(
            (1, 65, 64, 1), quantum=64, data_shards=2)

        self.assertEqual(directory.group_offsets, (0, 2, 4))
        self.assertEqual(directory.group_capacities, (64, 128))
        self.assertEqual(directory.rank_at_position, (1, 3, 4, 2))
        self.assertEqual(directory.coordinate(1), (64, 0, 0))
        self.assertEqual(directory.coordinate(3), (64, 0, 1))
        self.assertEqual(directory.coordinate(4), (128, 1, 0))
        self.assertEqual(directory.coordinate(2), (128, 1, 1))
        self.assertEqual(
            sorted(directory.rank_at_position),
            list(range(1, directory.rank_count + 1)))

    def test_ciphertext_frame_and_aad_have_one_canonical_binary_spelling(self):
        salt = b'S' * 32
        digest = hashlib.sha256(b'canonical page').digest()
        frame = encode_ciphertext_frame(1, 4096, digest, b'deflate bytes')
        padded = frame + bytes(64 - len(frame) % 64)

        self.assertEqual(decode_ciphertext_frame(padded),
                         (1, 4096, digest, b'deflate bytes'))
        aad = encode_ciphertext_row_aad(
            salt, digest, 7, 11, 2, 3, len(padded), 1, 4096, 13)
        self.assertEqual(aad, encode_ciphertext_row_aad(
            salt, digest, 7, 11, 2, 3, len(padded), 1, 4096, 13))
        self.assertNotEqual(aad, encode_ciphertext_row_aad(
            salt, digest, 7, 11, 3, 3, len(padded), 1, 4096, 13))
        with self.assertRaisesRegex(PageFabricError, 'padding'):
            decode_ciphertext_frame(padded[:-1] + b'X')

    def test_storage_locator_is_keyed_and_contains_no_public_digest(self):
        key = bytes(range(32))
        volume = b'V' * 16
        salt = b'S' * 32
        digest = hashlib.sha256(b'not visible to the provider').digest()
        first = opaque_row_locator(key, volume, salt, digest, 3, 5, 1)

        self.assertEqual(len(first), 32)
        self.assertNotEqual(first, digest)
        self.assertNotEqual(
            first, opaque_row_locator(key, volume, salt, digest, 3, 5, 2))
        self.assertNotEqual(
            first, opaque_row_locator(
                b'K' * 32, volume, salt, digest, 3, 5, 1))
        tag = stored_row_authenticator(b'A' * 32, first, b'ciphertext')
        self.assertEqual(len(tag), 16)
        self.assertNotEqual(
            tag, stored_row_authenticator(b'A' * 32, first, b'ciphertexu'))

    def test_ciphertext_row_capacity_is_the_smallest_group_multiple(self):
        extents = tuple(range(1, 513))
        directory = build_ciphertext_row_directory(extents, quantum=64)

        grouped = {}
        for rank, extent in enumerate(extents, 1):
            capacity, group, slot = directory.coordinate(rank)
            self.assertGreaterEqual(capacity, extent)
            self.assertEqual(capacity % directory.quantum, 0)
            grouped.setdefault(group, []).append((slot, rank, extent))
        for group, rows in grouped.items():
            self.assertEqual([slot for slot, _rank, _extent in rows],
                             list(range(len(rows))))
            largest = max(extent for _slot, _rank, extent in rows)
            expected = ((largest + directory.quantum - 1)
                        // directory.quantum) * directory.quantum
            self.assertEqual(directory.group_capacities[group], expected)

    def test_optimal_groups_may_trade_padding_for_one_less_parity_group(self):
        directory = build_ciphertext_row_directory(
            (1, 1, 1, 65), quantum=64, data_shards=2,
            parity_shards=2, tag_bytes=16, authenticator_bytes=16)
        strict_class_bytes = (3 + 4) * (64 + 16 + 16) \
            + (1 + 2) * (128 + 16 + 16)

        self.assertEqual(directory.group_count, 2)
        self.assertEqual(directory.stored_bytes,
                         4 * (64 + 16 + 16) + 4 * (128 + 16 + 16))
        self.assertLess(directory.stored_bytes, strict_class_bytes)

    def test_optimal_grouping_matches_unordered_set_partition_search(self):
        def all_costs(extents, quantum, data, parity):
            capacities = [((extent + quantum - 1) // quantum) * quantum
                          for extent in extents]
            groups = []
            costs = []

            def visit(rank):
                if rank == len(capacities):
                    costs.append(sum(
                        (len(group) + parity)
                        * (max(capacities[index] for index in group) + 32)
                        for group in groups))
                    return
                for group in groups:
                    if len(group) < data:
                        group.append(rank)
                        visit(rank + 1)
                        group.pop()
                groups.append([rank])
                visit(rank + 1)
                groups.pop()

            visit(0)
            return min(costs)

        for extents in ((1, 65, 64, 1), (1, 1, 129, 65, 65),
                        (7, 8, 9, 63, 64, 65)):
            directory = build_ciphertext_row_directory(
                extents, quantum=64, data_shards=3, parity_shards=2,
                tag_bytes=16, authenticator_bytes=16)
            self.assertEqual(directory.stored_bytes,
                             all_costs(extents, 64, 3, 2))

    def test_ciphertext_row_geometry_rejects_ambiguous_coordinates(self):
        with self.assertRaisesRegex(ValueError, 'power of two'):
            build_ciphertext_row_directory((1,), quantum=96)
        with self.assertRaisesRegex(ValueError, 'positive'):
            build_ciphertext_row_directory((0,), quantum=64)
        with self.assertRaises(IndexError):
            build_ciphertext_row_directory((1,), quantum=64).coordinate(0)

    def test_erasure_recovery_matrix_is_cold_direct_directory_state(self):
        data_shards, parity_shards = 3, 2
        directory = build_erasure_recovery_directory(
            data_shards, parity_shards)
        data = [bytes((slot * 31 + byte) & 255 for byte in range(97))
                for slot in range(data_shards)]
        generator = _generator(data_shards, parity_shards)
        rows = [_combine(coefficients, data, len(data[0]))
                for coefficients in generator]

        for mask in range(1 << (data_shards + parity_shards)):
            if mask.bit_count() != data_shards:
                self.assertEqual(directory.ordinal_by_mask[mask], -1)
                continue
            slots = [slot for slot in range(len(rows)) if mask & (1 << slot)]
            available = [rows[slot] for slot in slots]
            for target in range(data_shards):
                recovered = _combine(
                    directory.for_target(mask, target), available,
                    len(data[target]))
                self.assertEqual(recovered, data[target])

        with self.assertRaisesRegex(ValueError, 'exactly'):
            directory.for_target(1, 0)

    def test_ciphertext_directory_has_one_exact_encrypted_metadata_plaintext(self):
        digest = hashlib.sha256(b'canonical object').digest()
        directory = CiphertextDirectory(
            b'S' * 32, digest, 9, 190, 64, 64,
            (1, 0, 2),
            (CiphertextRankRecord(0, 0, 0, 23),
             CiphertextRankRecord(0, 1, 1, 41)),
            (CiphertextGroup(
                2, 1, 2, 128,
                (b'A' * 32, b'B' * 32, b'C' * 32)),),
            (build_erasure_recovery_directory(2, 1),))
        encoded = dump_ciphertext_directory(directory)

        self.assertEqual(load_ciphertext_directory(encoded), directory)
        self.assertEqual(dump_ciphertext_directory(
            load_ciphertext_directory(encoded)), encoded)
        with self.assertRaisesRegex(PageFabricError, 'trailing'):
            load_ciphertext_directory(encoded + b'\0')
        with self.assertRaisesRegex(PageFabricError, 'format'):
            load_ciphertext_directory(b'BAD!' + encoded[4:])

    def test_quotient_is_direct_and_resident_bytes_are_shared(self):
        payload = self.object()
        manifest, store = project(payload, page_size=64,
                                  data_shards=3, parity_shards=2)
        fabric = PageFabric(manifest, (store,))

        self.assertEqual(fabric.read(0, len(payload)), payload)
        self.assertIs(fabric.page(0), fabric.page(3))
        self.assertEqual(fabric.page(1), bytes(64))
        self.assertEqual(fabric.layout()['quotient_pages_saved'], 2)
        self.assertLess(fabric.resident_pages, manifest.page_count)

        resident = fabric.resident_pages
        self.assertEqual(fabric.release_resident(), resident)
        self.assertEqual(fabric.resident_pages, 0)
        self.assertEqual(fabric.read(0, 4), b'AAAA')

    def test_corrupt_primary_is_recovered_from_any_valid_k_shards(self):
        payload = self.object()
        manifest, primary = project(payload, page_size=64,
                                    data_shards=3, parity_shards=2)
        corrupt = MemoryShardStore(primary.records)
        key = manifest.shard_key(0, 0)
        record = corrupt.records[key]
        broken = bytearray(record.payload)
        broken[-1] ^= 1
        corrupt.records[key] = record.__class__(bytes(broken), record.proof)
        # Remove another shard. Two parity shards still tolerate both losses.
        corrupt.records.pop(manifest.shard_key(0, 1))
        fabric = PageFabric(manifest, (corrupt,))

        self.assertEqual(fabric.page(0), b'A' * 64)
        self.assertEqual(fabric.recovered_pages, 1)
        self.assertEqual(fabric.rejected_shards, 1)

    def test_storage_tiers_are_all_untrusted_but_ordered_by_latency(self):
        payload = self.object()
        manifest, remote = project(payload, page_size=64,
                                   data_shards=3, parity_shards=2)
        bad_cache = MemoryShardStore()
        key = manifest.shard_key(0, 0)
        bad_cache.put(key, b'not a shard')
        fabric = PageFabric(manifest, (bad_cache, remote))

        self.assertEqual(fabric.page(0), b'A' * 64)
        self.assertEqual(fabric.rejected_shards, 1)
        self.assertEqual(fabric.recovered_pages, 0)

    def test_loss_beyond_parity_is_rejected(self):
        payload = self.object()
        manifest, store = project(payload, page_size=64,
                                  data_shards=3, parity_shards=1)
        for slot in (0, 1):
            store.records.pop(manifest.shard_key(0, slot))
        fabric = PageFabric(manifest, (store,))
        with self.assertRaisesRegex(PageFabricError, 'not enough'):
            fabric.page(0)

    def test_sparse_wire_directory_opens_to_the_same_direct_ranks(self):
        payload = bytes(64 * 200) + b'A' * 64 + bytes(64 * 300) + b'B'
        manifest, _store = project(payload, page_size=64,
                                   data_shards=3, parity_shards=2)
        wire = dump_manifest(manifest)
        opened = load_manifest(memoryview(wire))

        self.assertEqual(opened, manifest)
        self.assertLess(len(wire), len(manifest.page_ranks) * 4)
        with self.assertRaisesRegex(PageFabricError, 'trailing'):
            load_manifest(wire + b'\0')

    def test_every_loss_pattern_within_parity_recovers(self):
        from itertools import combinations

        payload = b''.join(bytes([byte]) * 64 for byte in range(1, 7))
        manifest, complete = project(payload, page_size=64,
                                     data_shards=3, parity_shards=2)
        for missing in combinations(range(5), 2):
            records = dict(complete.records)
            for slot in missing:
                records.pop(manifest.shard_key(0, slot), None)
            fabric = PageFabric(manifest, (MemoryShardStore(records),))
            for page in range(3):
                self.assertEqual(fabric.page(page),
                                 bytes([page + 1]) * 64)

    def test_data_and_parity_may_be_distributed_as_separate_bundles(self):
        payload = self.object()
        manifest, complete = project(payload, page_size=64,
                                     data_shards=3, parity_shards=2)
        data_wire = dump_bundle(manifest, complete, 'data')
        parity_wire = dump_bundle(manifest, complete, 'parity')
        data_manifest, data_store = load_bundle(memoryview(data_wire))
        parity_manifest, parity_store = load_bundle(parity_wire)

        self.assertEqual(data_manifest, manifest)
        self.assertEqual(parity_manifest, manifest)
        self.assertEqual(data_store.materialized_records, 0)
        key = manifest.shard_key(0, 0)
        broken = data_store.records[key]
        self.assertEqual(data_store.materialized_records, 1)
        changed = bytearray(broken.payload)
        changed[-1] ^= 1
        data_store.records[key] = broken.__class__(
            bytes(changed), broken.digest)
        fabric = PageFabric(manifest, (data_store, parity_store))
        self.assertEqual(fabric.page(0), b'A' * 64)
        self.assertEqual(fabric.recovered_pages, 1)
        self.assertLess(len(data_wire),
                        len(dump_bundle(manifest, complete, 'all')))

    def test_data_delivery_does_not_materialize_discarded_parity_payloads(self):
        payload = self.object()
        complete_manifest, complete = project(
            payload, page_size=64, data_shards=3, parity_shards=2)
        data_manifest, data = project(
            payload, page_size=64, data_shards=3, parity_shards=2,
            stored_shards='data')

        self.assertEqual(data_manifest, complete_manifest)
        self.assertTrue(data.records)
        self.assertTrue(all(
            key[3] < data_manifest.data_shards for key in data.records))
        self.assertEqual(
            dump_bundle(data_manifest, data, 'data'),
            dump_bundle(complete_manifest, complete, 'data'))

    def test_bundle_open_keeps_payloads_and_digests_mapped(self):
        manifest, complete = project(
            self.object(), page_size=64, data_shards=3, parity_shards=2)
        wire = dump_bundle(manifest, complete, 'data')
        opened, store = load_bundle(memoryview(wire))
        fabric = PageFabric(opened, (store,))

        self.assertEqual(store.materialized_records, 0)
        self.assertEqual(fabric.layout()['mapped_records_materialized'], 0)
        self.assertEqual(fabric.page(0), b'A' * 64)
        self.assertEqual(store.materialized_records, 1)
        # The quotient's duplicate logical coordinate is a direct resident hit.
        self.assertIs(fabric.page(0), fabric.page(3))
        self.assertEqual(store.materialized_records, 1)

    def test_bundle_directory_precedes_every_range_payload(self):
        manifest, complete = project(
            self.object(), page_size=64, data_shards=3, parity_shards=2)
        wire = dump_bundle(manifest, complete, 'data')
        _magic, version, header_bytes, manifest_bytes, records, proofs = \
            struct.unpack_from('<4sHHIII', wire)
        prefix = (header_bytes + manifest_bytes + records * 46
                  + proofs * 37)

        self.assertEqual(version, 4)
        self.assertLess(prefix, len(wire))
        first = struct.unpack_from(
            '<IHII32s', wire, header_bytes + manifest_bytes)
        self.assertEqual(first[2], 0)
        self.assertGreater(first[3], 0)
        opened, store = load_bundle(memoryview(wire))
        record = store.get(opened.shard_key(first[0], first[1]))
        self.assertEqual(bytes(record.payload), wire[prefix:prefix + first[3]])

    def test_range_store_fetches_only_the_touched_shard(self):
        manifest, complete = project(
            self.object(), page_size=64, data_shards=3, parity_shards=2)
        wire = dump_bundle(manifest, complete, 'data')
        prefix_bytes = bundle_prefix_size(wire[:20])
        requests = []

        def read(offset, length):
            requests.append((offset, length))
            return memoryview(wire)[offset:offset + length]

        opened, store = load_range_bundle(
            memoryview(wire)[:prefix_bytes], read,
            hashlib.sha256(wire[:prefix_bytes]).digest())
        fabric = PageFabric(opened, (store,))

        self.assertEqual(fabric.page(0), b'A' * 64)
        self.assertEqual(len(requests), 1)
        self.assertEqual(store.fetched_bytes, requests[0][1])
        self.assertLess(prefix_bytes + store.fetched_bytes, len(wire))
        self.assertIs(fabric.page(0), fabric.page(3))
        self.assertEqual(len(requests), 1)
        with self.assertRaisesRegex(PageFabricError, 'digest'):
            load_range_bundle(wire[:prefix_bytes], read, bytes(32))

    def test_sparse_projection_and_subpage_view_do_not_materialize_zeros(self):
        length = 4 * 64
        manifest, store = project_sparse(
            length, 64, ((1, b'A' * 64), (3, b'B' * 64)),
            data_shards=2, parity_shards=1)
        fabric = PageFabric(manifest, (store,))
        backing = SubpageBacking(fabric, 16)

        self.assertEqual(backing.page(0), bytes(16))
        self.assertEqual(fabric.resident_pages, 0)
        self.assertEqual(backing.page(4), b'A' * 16)
        self.assertEqual(fabric.resident_pages, 1)
        self.assertIs(backing.page(4), backing.page(4))
        self.assertEqual(backing.page(12), b'B' * 16)

        self.assertEqual(backing.find(4, 0, 16, (65,)), 0)
        self.assertEqual(backing.find(4, 1, 15, (66,)), None)
        self.assertEqual(backing.release_resident(), 2)
        self.assertEqual(fabric.resident_pages, 0)


if __name__ == '__main__':
    unittest.main()
