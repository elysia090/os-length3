# sods portable execution core

A dependency-free Rust unit for the portable execution-core migration. It does not
require ricebox, an OCI bundle, a desktop session, or the translator crate.

The first implemented module, `byte_effect`, specifies and checks the proposed
private v1 96-byte byte-effect record and once-only copy completion. It is not a
public kernel protocol. `validate_backing_bounds` checks arithmetic against supplied
extents, not guest mapping permissions or live allocations. Completion records must
be scoped to the owning core instance by the eventual integration.

The TS kernel can use explicitly installed Rust-backed file payloads through the
limited Vfs entrance below. Kernel state remains in TS; kernel allocation leases, mapping pins,
host callbacks, syscall execution and Worker lifecycle are not implemented here. No stub claims success for them. Native unit tests do not establish
Wasm ABI compatibility, runtime memory safety or a performance improvement.

Run the focused checks with an existing Rust toolchain:

```
cargo test --manifest-path module/sods/core/Cargo.toml --locked --offline -j 1
```

## First connected slice: owned regular-file payloads

`files` implements create/read/write/truncate/close in Rust. The opt-in
`runtime/core/files.ts` facade calls the actual Wasm exports and returns independent
byte snapshots. It does not replace `Vfs` or the running kernel's `File`: namespace,
permissions, descriptors, lazy loading and MAP_SHARED propagation remain unported.
No guest execution memory is touched, so mapping-pin enforcement and the proposed
96-byte effect ABI are not claimed by this slice.

A caller supplies a trusted matching core module and an explicit per-file length
limit, then owns each returned handle until `close()`. Close is idempotent; IDs are
not reused. Dropping the store/handles permits the instance to be collected, not a
synchronous reclamation guarantee. Empty ID-table slots and scratch capacity can be
retained, so the limit is not a total-memory bound. Input snapshots, scratch import,
Rust file storage and output snapshots have explicit copy/retention costs; no
zero-copy or performance claim is made.

```
const files = await loadCoreFiles(module, 1024 * 1024);
const file = files.create(new TextEncoder().encode('hello'));
file.write(5, new TextEncoder().encode('!'));
const snapshot = file.read(0, 6);
file.close();
```

Build/test with an already-installed wasm32 target (no automatic installation):

```
cargo build --manifest-path module/sods/core/Cargo.toml --target wasm32-unknown-unknown --locked --offline -j 1
SODS_CORE_WASM=module/sods/core/target/wasm32-unknown-unknown/debug/sods_core.wasm node --test module/sods/test/runtime/core-files.test.ts
```

The integration test is explicitly skipped without its artifact variable. A skipped
case is not evidence that the Wasm integration passes. Scratch views are private
and only valid until the next export; callbacks and asynchronous effects are absent
from this first slice. Raw exports are not a supported safe embedding API.

Compatibility details: these are File **payload primitives**, not Linux read/write
syscalls. Like the inspected TS File.write primitive, an empty write beyond EOF
extends with zeros; syscall-level zero-write rules must be applied by a future
kernel layer. The configured length limit is checked on that operation too.

Current copy paths are caller → owned JS snapshot → core scratch → file payload
for create/write, and file payload → core scratch → owned JS snapshot for read.
These are deliberately conservative first-integration costs, not minimal copies.
The facade checks the input byte length before snapshotting and again afterward;
this is not a quota against arbitrary hostile embedding objects or allocations.

Use an artifact built from the same matching crate revision. The v1 export check
rejects unknown versions but is not code authentication or exhaustive export/schema
validation. This API is not a sandbox for arbitrary supplied Wasm modules.

## Consuming-read migration boundary

The existing Vfs file syscall now calls `File.readInto` rather than obtaining an
escaping file view. Legacy TS `read`/`data`/`share` retain their current behavior. Raw-alias
overlap tests preserve legacy behavior, not a supported mediated mutation contract.
The Rust facade offers the same consuming-copy shape: file → core scratch → caller
destination, without the extra output snapshot allocation of `read`. It does not
retain the destination or invoke a host callback while scratch is live.

This is a shared operation boundary; the explicit file entrance below now connects
it to Vfs, without replacing the entire Vfs. Actual Vfs and
syscall tests cover replacement retaining the old inode through an open fd,
independent pread offsets, partial reads before a memory boundary, and fd close not
closing the inode. The explicit entrance supplies ownership scope, errno mapping and ordinary shared
mapping integration. Loader migration remains unimplemented. Neither namespace replacement nor
fd close can reclaim a payload still held by another name, descriptor, mapping or
image. No silent promotion to a TS payload or second mutable authority is added.

## Explicit Vfs file scope

`runtime/linux/core-files.ts` provides `loadFileScope(module, perFileLimit)` and
`scope.writeFile(existingVfs, path, bytes, mode)`. Only those explicitly installed
regular files have Rust payloads. Ordinary `Vfs.writeFile`, guest-created files,
lazy pack loaders and anonymous shared mappings still use the existing backend;
there is no automatic promotion or fallback. Namespace, inode identity/metadata,
FDs and mapping visibility remain TS-owned for this incremental migration.

This entrance deliberately does not support mutable `data`/`_data` views. Its
`read` and `share` return independent snapshots. Loader/cache release is absent.
The scope retains all created payloads, including unlinked and replaced inodes,
until `dispose()`. The owner must first end **all** processes, mappings, images
and embedding operations using them. This precondition is not reference-counted
or automatically verified; premature disposal invalidates later byte operations
with an explicit scope-closed failure. No fd close or namespace replacement
closes the Rust handle. Disposal frees Rust payload allocations, not necessarily
Wasm linear-memory pages or retained scratch capacity.

Write propagates the same captured bytes to Rust and mappings. Truncate propagates
zeros without allocating a read-back after commit. Existing mapping scans/baselines
still cost proportional to scanned/mapped bytes; they are not a second independent
canonical file. A multi-run settle can partly succeed before later failure, as
can propagation to an invalid embedding memory. It is not transactional rollback
or a new concurrent-memory/pin guarantee. Shared input capture is not atomic.

Focused tests use the actual Rust artifact and existing Kernel/Process syscalls:
open/read/write/ftruncate/mmap/close/munmap, old inode after path replacement,
mapping writes after fd close, two-map visibility, snapshot ownership and Mirror.
They do not establish translated-program, Worker, concurrent shared-memory or
full filesystem compatibility. Generic core errors are translated to filesystem
errnos only at this adapter; payload size failure is EFBIG and allocation refusal
is ENOSPC. Engine traps and scope misuse remain failures, not false successful IO.

## Next integration gate: loader effects and destination lifetime

Priority is destination lifetime before lazy loading, then migration of pending
kernel operations rather than more standalone payload helpers. A source probe of
existing TS lazy files reproduced a real failure: the loader replaced
`Process.memory` during read, the syscall returned 3, and `abc` was written into
the old memory while the current memory remained zero. **This remains unresolved.**
No pending-read or pin fix is implemented by the two-process regression below.
This is an existing raw
embedding path, not evidence that the new Rust file entrance supports lazy loading.

The next finite operation is a pending ordinary-file read. It must preserve the
originating process/image/mapping identity across loading, hold no guest view or
Rust byte lease over a host callback, and acquire a destination only after checking
that identity. Merely reacquiring `p.bytes` can target a different image; merely
checking buffer identity misses same-memory exec/renew. The checks must cover
readv scatter as well as read, including partial success and offset commit.

During migration, TS Description remains the sole offset owner until all of its
mutators move. A Rust pending operation may own the operation identity, source
revision, accepted range and copy outcome, but not an independently writable
shadow descriptor offset. Reentrant offset/lifetime changes need an explicit
reservation/rejection rule before a host loader is enabled. Copy completion cannot
be invented from a successful loader return. Loader external effects are not
rolled back. No generic pin or pending-read implementation is claimed yet.

The two-process regression now checks the existing non-lazy slice through real
syscalls: separate process memories map one Rust-backed inode, msync/read observe
the other mapping, entry replacement and fd close preserve it, refused writes and
truncation leave bytes/version unchanged, and an unmapped/reused region receives
no later file propagation. This is deterministic process interleaving, not a test
of simultaneous OS threads, shared-memory stores or arbitrary embedding mutation.
