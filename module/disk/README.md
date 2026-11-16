# disk

Storage mechanics below product policy. `indexeddb.ts` takes an already opened database and explicit store
layout: it opens nothing on its own, knows no product or user, and never falls back to a cache. The caller
owns authorization, service/user separation, volume selection, migrations and lifetime. A database handle
is not authentication for a remote service.

The first consumer is why's existing browser core (`why/api/worker.ts`). Node metadata, file bytes and the
generation commit in one transaction. The expected generation is compared inside that transaction, so stale
writers fail even without Web Locks. Completion waits for the transaction's terminal event, not just a
request's result. Writes request IndexedDB's strict durability mode; browser eviction is still possible.

This does not add automatic persistence to ricebox, claim a POSIX disk, or wire sods `fsync` to an external
volume. Those remain distinct from why's existing browser database. A persistent guest mount must wait for
the backing store's commit before returning successful `fsync`.

`node --test why/api/disk.test.ts why/api/worker-disk.test.ts` checks transaction ordering and the actual
worker's failure recovery. The tests are included in `npm test`.
