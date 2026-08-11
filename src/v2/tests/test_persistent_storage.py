"""Crash, retry, fencing and collection properties of persistent roots."""

import hashlib
import unittest

from kernel.storage import (PersistentVolume, RootConflict, StaleSupervisor,
                            StorageRetired)


class TestPersistentVolume(unittest.TestCase):
    def supervisor(self, volume, byte):
        return volume.claim_supervisor(bytes((byte,)) * 16)

    def publish(self, volume, supervisor, payload, expected=None):
        lease = volume.begin(supervisor, expected)
        volume.put(supervisor, lease, payload)
        manifest = volume.put(
            supervisor, lease, b'manifest:' + payload)
        return lease, volume.publish(supervisor, lease, manifest)

    def test_root_publish_is_monotonic_idempotent_and_restore_appends(self):
        volume = PersistentVolume()
        supervisor = self.supervisor(volume, 1)
        first_lease, first = self.publish(volume, supervisor, b'first')

        self.assertIs(volume.publish(
            supervisor, first_lease, first.manifest), first)
        volume.pin_root(supervisor, first.digest)
        _second_lease, second = self.publish(
            volume, supervisor, b'second', first.digest)
        restored = volume.restore(supervisor, first.digest)

        self.assertEqual((first.sequence, second.sequence, restored.sequence),
                         (1, 2, 3))
        self.assertEqual(restored.parent, second.digest)
        self.assertEqual(restored.manifest, first.manifest)
        self.assertEqual(restored.objects, first.objects)
        self.assertEqual(len(restored.descriptor), len(first.descriptor))
        self.assertEqual(hashlib.sha256(restored.descriptor).digest(),
                         restored.digest)

    def test_root_pointer_extent_does_not_grow_with_filesystem_state(self):
        volume = PersistentVolume()
        supervisor = self.supervisor(volume, 9)
        small_lease = volume.begin(supervisor)
        small_manifest = volume.put(supervisor, small_lease, b'small')
        small = volume.publish(supervisor, small_lease, small_manifest)

        large_lease = volume.begin(supervisor, small.digest)
        for index in range(100):
            volume.put(supervisor, large_lease,
                       b'page:' + index.to_bytes(4, 'little'))
        large_manifest = volume.put(supervisor, large_lease, b'large')
        large = volume.publish(supervisor, large_lease, large_manifest)

        self.assertEqual(len(small.descriptor), len(large.descriptor))
        self.assertNotEqual(small.object_root, large.object_root)

    def test_root_compare_and_swap_keeps_losing_objects_as_orphans(self):
        volume = PersistentVolume()
        supervisor = self.supervisor(volume, 2)
        left = volume.begin(supervisor)
        right = volume.begin(supervisor)
        left_manifest = volume.put(supervisor, left, b'left manifest')
        right_manifest = volume.put(supervisor, right, b'right manifest')

        volume.publish(supervisor, left, left_manifest)
        with self.assertRaises(RootConflict):
            volume.publish(supervisor, right, right_manifest)
        volume.abort(supervisor, right)
        fence = volume.gc_fence(supervisor)

        self.assertIn(right_manifest,
                      volume.collect_orphans(supervisor, fence))
        self.assertEqual(volume.get(left_manifest), b'left manifest')

    def test_new_supervisor_fences_old_worker_before_reclaim(self):
        volume = PersistentVolume()
        old = self.supervisor(volume, 3)
        interrupted = volume.begin(old)
        orphan = volume.put(old, interrupted, b'unpublished page')

        current = self.supervisor(volume, 4)
        with self.assertRaises(StaleSupervisor):
            volume.put(old, interrupted, b'late completion')
        self.assertEqual(volume.active_intents, 1)
        self.assertEqual(volume.reclaim_stale_intents(current), 1)

        fence = volume.gc_fence(current)
        self.assertEqual(volume.collect_orphans(current, fence), (orphan,))
        self.assertEqual(volume.object_count, 0)

    def test_gc_rechecks_active_intents_and_never_crosses_its_fence(self):
        volume = PersistentVolume()
        supervisor = self.supervisor(volume, 5)
        old = volume.begin(supervisor)
        old_object = volume.put(supervisor, old, b'old orphan')
        fence = volume.gc_fence(supervisor)

        volume.abort(supervisor, old)
        current = volume.begin(supervisor)
        new_object = volume.put(supervisor, current, b'new allocation')
        self.assertEqual(volume.collect_orphans(supervisor, fence),
                         (old_object,))
        self.assertEqual(volume.get(new_object), b'new allocation')

        next_fence = volume.gc_fence(supervisor)
        self.assertEqual(volume.collect_orphans(supervisor, next_fence), ())
        volume.abort(supervisor, current)
        self.assertEqual(volume.collect_orphans(supervisor, next_fence),
                         (new_object,))

    def test_published_cut_survives_supervisor_death_without_old_ack(self):
        volume = PersistentVolume()
        old = self.supervisor(volume, 6)
        _lease, root = self.publish(volume, old, b'dirty cow page')

        current = self.supervisor(volume, 7)
        self.assertEqual(volume.reclaim_stale_intents(current), 0)
        self.assertEqual(volume.current_root, root)
        for identity in root.objects:
            self.assertEqual(len(volume.get(identity)) > 0, True)

    def test_generation_exhaustion_retires_instead_of_reusing_a_token(self):
        volume = PersistentVolume(counter_limit=4)
        supervisor = self.supervisor(volume, 8)
        tokens = [volume.begin(supervisor).token for _unused in range(3)]

        self.assertEqual(tokens, [1, 2, 3])
        with self.assertRaises(StorageRetired):
            volume.begin(supervisor)
        with self.assertRaises(StorageRetired):
            volume.begin(supervisor)


if __name__ == '__main__':
    unittest.main()
