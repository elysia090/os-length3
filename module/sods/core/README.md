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
case is not evidence that the Wasm integration passes. Scratch views are private; input scratch is transient, while a pending read
leases its scratch until matching finish; callbacks and asynchronous effects are absent
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

Use an artifact built from the same matching crate revision. The v2 file-export check
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
the old memory while the current memory remained zero. The two-process regression
did not fix it. The bounded guard below now rejects this ordinary-file read path.
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

### Implemented ordinary-file read lifetime guard

The existing TS syscall owner now captures process assignment identity, backing
buffer identity, memory renewal/mapping epoch, and open-description offset revision
before source access. File.readInto checks these after source access (including a
throwing loader), then performs a built-in typed-array copy without a user `set`
callback. Rust-backed files check before entering the callback-free core copy;
no guard is called while a Rust scratch view is outstanding.

A stale read is a host ReadLifetimeError, not EFAULT or a successful short count.
Kernel.attempt retires the affected process and rethrows it before guest resumption.
Cleanup failure is retained on the original error and scheduling is stopped; this
does not claim successful full cleanup. File readv preserves already-committed
prefix bytes/offset but does not swallow a later stale error as partial success.
The TS Description remains the only offset authority. Descriptor offset ABA and
process memory assignment ABA are detected, not just pointer inequality.

Regression coverage includes replacement, replacement followed by loader failure,
assignment ABA, grow, same-memory renew, real reentrant mmap/mremap, cover without
grow, offset ABA, later-vector invalidation, and cleanup failure. The renewal test
uses the real renewal method with minimal image metadata, not a translated exec.

This is **not** the complete Rust pending-read/slot-pin implementation. It closes
the reproduced supported ordinary-file copy path; console/device consuming reads,
sendfile, malicious method/property replacement, and general concurrent embedding
lifetime changes are not thereby protected. Epochs conservatively invalidate even
unrelated mapping operations and release by another sharing process. Concurrent
shared byte stores are content changes, not invalidations or atomic snapshots.

Current cost is O(1) identity state per process/description/memory and O(1) checks
per read, with short-lived closure/token allocations; these are implementation
costs, not a proven lower bound. No extra payload snapshot is introduced by the
guard. Moving pending operation state into Rust must preserve these rejection,
copy/offset ordering and cleanup contracts rather than add a second mutable offset.

## Core-owned pending read: private files ABI v2

The ready-payload path now runs `readTo → OwnedFile → read_begin → host copy →
read_finish → Description.offset`. Rust owns one pending record containing file
identity, requested range, actual output length, operation ID and scratch lease.
The core accepts the trusted host adapter’s matching completion report once; it
does not independently verify that host copying occurred. Only that successful
acceptance returns the count used by the real syscall for its offset update. The TS Description remains the sole offset authority.

During the lease, input/create/write/truncate/close/another read are rejected.
Wrong identity/count or duplicate completion cannot release a different operation.
The facade aborts a failed copy as **unknown effect**, not rollback, and propagates
the failure. If abort also fails both errors survive. Protocol errors are host
failures rather than ordinary filesystem errnos. EOF still has a zero-length
completion. The private files ABI is now v2; v1 artifacts are rejected.

This stores one constant-size record and uses existing scratch; it does not make
an extra payload copy or per-operation Rust heap allocation. Maximum in-flight is
one per core instance, matching its single scratch. IDs never wrap: signed-u32
positive IDs exhaust after 2^31−1 starts and fail explicitly. This finite limit
and one extra completion crossing per read are current design costs, not a final
performance or lifetime target. The host's existing identity closures/tokens also
remain costs to revisit, not theoretical necessities. Concurrent independent
operations may eventually justify multiple slots; no speculative queue is added.

Tests exercise the actual Wasm lease, invalid/duplicate completions, prior-ABI
rejection, and a failed destination copy through the real syscall adapter followed
by a successful retry. They also check pread offset independence, readv and EOF.
Guest destination identity remains the host guard's responsibility, not something
this core record can prove. Lazy host effects and descriptor state are not ported.

### Finite lazy-materialization order gate

| Current entrance | Work that must not be prematurely committed before loading/identity validation |
|---|---|
| file read/readv | destination copy and descriptor offset; current guard supplies the synchronous rejection order |
| write/append | append position currently chosen from file.size before File.write; loaded size must be known before selecting it |
| truncate/open O_TRUNC | own/reload retention and size/content effects must follow successful materialization |
| mmap/mremap | address reservation, old mapping retirement, guest initialization and mapping publication require ordered failure handling |
| share/bytes/image preparation | retained source snapshot and source revision must match; source callbacks cannot silently replace the accepted image |

Before lazy core entry is enabled, each entrance needs success, source-throw,
same-inode reentry and close/stale outcomes. Read-only lazy demos would hide these
mutation-order issues and are not introduced. The next step is this finite order
contract, not a claim that pending ready reads have already solved lazy IO.

### Materialization stage 1: ownership and write position

File.materialize now resolves an ordinary lazy source before write/truncate call
`own()` and discard reload/cache ownership. A throwing loader therefore leaves
reload ownership available for retry. This is not an all-allocation-failures
transaction guarantee: later growth or mapping propagation can still fail.

The real file write/pwrite/append path validates process and description identity
on both materialization success and failure, then chooses the offset (including
append's loaded size) and commits the write. A loader that replaces memory and
throws cannot become an ordinary EIO returned into the new image. The existing
Rust-ready File implementation has no loader callback and materialize is live-only.

Open O_TRUNC and other materialization callers are not declared lifetime-safe by
this change. In particular, open currently selects an fd before a possible source
callback; callback-after-fd-selection needs re-selection/reservation analysis.
Rust lazy loading remains disabled while those entrance contracts are incomplete.
Mapping materialization/publication ordering is a separate change with its own
same-inode dirty-map and failure tests, not implied by this ownership fix.

### Materialization stage 2: mapping source snapshots

mmap now obtains an owned initial snapshot, with source/identity checks, before
reserving addresses, retiring an old MAP_FIXED mapping or writing guest memory.
mremap similarly obtains every required growing-file tail before its destructive
phase. Source failure therefore does not reserve/publish the new mapping or remove
the old one. Snapshot reads still settle shared file changes; source observation
can update canonical file bytes/baselines, so this is not a claim of zero effects
or full transactionality on every failure.

File.snapshot uses the existing read/settle semantics and then copies the range.
The Rust-backed override already receives an owned snapshot from its pending-read
path and adds no second snapshot copy. Legacy TS mappings now retain an extra
range snapshot until publication, a deliberate cost to avoid source aliases being
zeroed by destination replacement. Concurrent guest stores and later allocation/
publication failures remain outside a general atomic/pin guarantee.

Regressions cover same-inode dirty MAP_FIXED replacement, source aliasing the fixed
destination, later-tail failure in an explicit multi-record mapping fixture, and
real Rust-backed mmap/mremap through Kernel/Process. madvise's zero-then-read order,
O_TRUNC fd selection, and source effects in image setup remain separate unfinished
entrances. These fixes still do not enable Rust lazy loading automatically.

Abnormal retirement correction: a source callback that replaces memory can leave
old Mapping records pointing through the Process to unrelated new bytes. Normal
unmap/settle during fatal cleanup would then corrupt the old inode. Lost-identity
retirement now first detaches the Process mapping list, then removes those inode
registrations **without reading guest bytes or writing payloads**, before ordinary
process teardown. Last legitimately settled payload is retained; unobserved dirty
bytes may be lost. This is neither rollback nor normal exit durability semantics.
Other processes' registrations remain active, and duplicate discard does not alter
the mapped count twice. Conservative sharing hints may persist until a later
normal mapping update; discard deliberately avoids touching other guest memories.

The regression first reproduced fabricated zero writeback (expected 7, observed
0) after memory replacement. It now verifies no such writeback, preservation of
already-settled bytes, and continuing propagation to another process's mapping.
Normal exit/unmap still settles mappings. Cleanup-failure reporting remains
separate from a claim that all resources were recovered.

### Materialization stage 3: truncation and fd installation

Regular-file O_TRUNC keeps its initial EMFILE precedence check, then materializes
and validates process identity, reselects a currently free fd, and only then
truncates and installs. A loader occupying the initial candidate is not closed by
the outer open; if no fd remains, the file is not truncated. No new reservation
system is introduced for the callback-free truncate/install interval.

truncate/ftruncate preserve existing path/fd/permission and length refusal order,
then validate identity across materialization before content mutation. Holding the
already-selected inode is distinct from looking a possibly reused fd up again.
Regression cases include candidate occupation, exhaustion during loading,
replacement followed by loader throw, and refusal before any source invocation.
These are ordinary synchronous File/OwnedFile contracts, not arbitrary overridden
methods or concurrent external fd-table mutation guarantees.

### Materialization stage 4: madvise restoration

Shared-file madvise now settles existing records and captures every restoration
snapshot before zeroing the advised guest region. Failure in a later snapshot
does not erase earlier regions. Source/identity validation also runs on throws;
invalidated owners use the abnormal no-writeback retirement path. Overlapping
embedding-created records retain their previous restoration order.

The temporary retention cost is the sum of captured restoration ranges, including
overlap, rather than a proven minimal working set. Rust-backed reads use their
existing owned result without a second JS copy. Normal shared guest writes are
settled before restoration, so this is not a rollback of dirty file data. Source
settling itself can have effects even when a later snapshot fails.

### Materialization stage 5: executable source and process identity

Image preparation now distinguishes the version-managed source from the process
that may execute it. Ordinary shared-file settling precedes source revision
capture. Source/share, keeper and translator/error-classifier callbacks must leave
that revision unchanged before the result is adopted. Cache entries are stamped
with the captured revision, never a new revision read after translating old bytes.
Changed sources raise ImageSourceChangedError; callbacks are not automatically
retried. An existing old-revision cache may remain but cannot match a new revision.

exec checks the original process identity after head/source and image preparation,
on success and throw, before its destructive image transition. A process-changing
callback is fatal via the established no-writeback retirement path. Source change
alone is a host preparation failure, not a claim that a different process image
was installed or that callback side effects were rolled back.

Tests use valid minimal Wasm image metadata for cache/preparation, not a translated
program execution claim. They include the reproduced old-bytes/new-stamp mismatch,
normal dirty executable settling, keeper/classifier/consolidation changes,
unchanged ENOEXEC, actual exec syscall rejection before installation, and the real
Rust-backed source-copy path. This guards version-managed write/truncate/settle;
legacy raw aliases or a translator mutating its supplied view bypass versioning
and are not made immutable by this check. Rust lazy loader integration remains a
separate step, including same-inode load reentry and remaining transfer callers.

The stage-5 guard does not newly cover direct consolidateDue() or Image.more()
execution. Those later-code paths retain their existing contracts and require
separate review before any wider source-lifetime guarantee.

### Materialization stage 6: bounded file transfers

copy_file_range captures owned source bytes before destination materialization.
Both callbacks validate the original process and both descriptor-offset revisions,
on success and throw, before payload or offset publication. An invalidated process
uses the existing fatal no-writeback retirement. Source settling/callback effects
are not rolled back. The transient source retention is the accepted range length;
Rust snapshots reuse their owned result, while legacy TS ranges require a copy.
This is not a minimal-copy claim or protection against concurrent shared mutation.

fallocate now derives KEEP_SIZE clipping and expansion from loaded bytes, not a
lazy size hint. Existing mode/access and over-limit expansion refusals remain
before callbacks where the previous truncate path refused them. Ordinary loader
failure leaves offsets and the operation's payload mutation uncommitted; source
callbacks can still have independent effects.

The remaining sendfile path can wait after partial output and needs its own
accepted-prefix/offset contract; it is deliberately not covered by this change.
Review also identified separate same-inode loading reentry and deferred-image
revision/adoption gates. Rust lazy is still disabled. These guards are migration
prerequisites, not a second TS implementation of Rust-owned lazy state.

### Materialization stage 7: synchronous same-inode loading

The existing synchronous File source has an explicit loading attempt. Reentrant
materialize/data, own/given/release, map or settle on the same inode fails with EIO
before their effects and poisons that attempt. Even if the callback catches the
inner error, its returned bytes are not adopted. Failure clears the attempt and
retains the source for a later independent retry. Other inode work is allowed and
is not rolled back; A-to-B-to-A cycles poison A, not a transaction over B.

There is no asynchronous waiter queue: the source returns Uint8Array synchronously,
so a same-stack waiter cannot await its own completion. Two processes sharing the
inode observe EIO on reentrant reads without advancing offsets or copying bytes;
subsequent independent reads share the successfully materialized source. Abnormal
mapping abandonment stays available for cleanup; normal unmap must still settle.
The per-inode guard uses constant state, no successful-attempt queue/allocation
or extra payload copy (errors still allocate their normal diagnostic objects). This does not establish remote concurrency safety. Public raw-field
mutation, escaping aliases and arbitrary overrides remain unsupported embeddings.

This is the legacy-source boundary contract for migration, not a Rust lazy
implementation. The real-Wasm regression covers a TS lazy source reading an
independent Rust inode and releasing its read lease, not Rust-owned loading state.
Rust must eventually own the lazy attempt/source identity with its payload; no
second canonical lazy state should be retained after that migration.

### Stage 8: explicit Rust-owned lazy payloads (files ABI 3)

`loadFileScope(...).lazyFile(vfs, path, loader)` now installs an explicitly
Rust-owned lazy inode. The Rust slot owns payload, source identity and loading
attempt/poison state together. TS retains only the source-token-to-host-callback
registry and existing inode metadata. It does not maintain a second unloaded /
loading / loaded flag; File's legacy load/reload fields stay null for these inodes.
This opt-in entrance does not automatically migrate pack loaders or ordinary files.

Load begins with a non-reused operation token. Matching success atomically adopts
owned bytes and removes the source. Poison, failure or failed allocation retires
the attempt but preserves the source for retry; stale completion cannot retire a
new attempt. Close retires the slot permanently. Same-inode reentry fails even if
caught by the loader. Different inode loads may nest: no read scratch lease is
held across a source callback. This remains synchronous, not a remote/async waiter
queue. Ordinary source exceptions become EIO in the inode adapter; ABI/cleanup or
scope lifetime failures remain distinct. Process identity is checked after loading
before readInto copies or reports accepted bytes. Loaded payload adoption itself
is not rolled back when the requesting process was replaced.

Real Wasm tests cover two-process sharing, swallowed reentry, independent nested
load, retry, close/dispose during loading, size limits, append/truncate and
post-callback process replacement. ABI 2 artifacts are rejected rather than
silently falling back. Ready materialization currently requires begin plus size
host crossings; loading adds source query, input capture and matching completion.
Source capture still copies host bytes to an owned JS snapshot, to scratch, then
to canonical payload (three length-n copies for an n-byte source), and
reads still copy via scratch. These costs and retained Wasm capacity are not the
claimed lower bound. Source/operation IDs are finite, non-reused values in `1..=2^31-1`.

No source eviction/reload is offered yet (`release` remains zero); `given` does not
replace a Rust source. Raw data/alias mutation and arbitrary overrides remain
unsupported. Kernel namespace/FD/process/mapping state is still TS, and sendfile
partial effects plus deferred-image contracts remain separate migration gates.

### Stage 9: reloadable pack sources (files ABI 4)

`mountPack(scope.mountTarget(vfs), index, reading)` now selects Rust payloads for
all newly mounted pack files through the existing neutral MountTarget port.
Directories, links, origin and hardlink identity remain the existing Vfs behavior.
The ordinary `mountTarget(vfs)` default and Worker/runnable boot paths are not
silently switched: their matching core artifact injection and root/scope lifetime
still require integration. No fallback conceals a missing or mismatched artifact.

Rust now distinguishes source-backed Unloaded/Loading/Loaded from source-free
Owned payloads and keeps logical size separate from resident bytes. Load/given
success retains the source; successful write/truncate or explicit own detaches it.
Failed mutation retains reload eligibility. Release drops the payload but not
logical size, source identity or inode version. The host callback registry follows
that source lifetime. `given` adopts only an unloaded source, does nothing when
already loaded, and rejects Loading reentry. Upstream must authenticate root bytes;
source identity is not a digest check.

Kernel held/free use storage-neutral resident/releasable byte accessors rather
than mutable `_data`. Existing tree-local Loaded/keeper ownership remains in use.
Mapped Rust inodes conservatively refuse eviction and report zero releasable bytes;
this prevents a later dirty writeback from invoking a reload callback inside its
commit. Dirty writes are preserved, not discarded or represented as clean source.
Mapping-aware eviction remains deferred. Mapping settle still calls own before
copy, so arbitrary allocation/host failures there are not claimed failure-atomic
like the normal precommit write/truncate refusal cases. `held().files` remains
reloadable resident-file accounting, not all dirty payload or Wasm capacity.
Dispose removes source accounting entries;
its existing requirement to end all scope users first remains unchanged.

Tests mount a real hashed pack, preserve hardlinks, give hot bytes without fetching,
release/reload through failed integrity checks, preserve source after failed
mutation, and honor two kernels' shared keepers. Empty files also transition back
to Unloaded even when release returns zero. Resident bytes exclude Vec capacity,
shared scratch and retained Wasm pages: dropping a payload is not an OS-memory
return claim. HTTP whole-pack response retention remains a separate reader resource.

Cost derivation: an n-byte mutable external source requires a stable accepted value
before canonical publication. The current host snapshot, scratch transfer and
payload copy cost 3n copied bytes, in addition to pack verification/decompression
and read output. Moving the completed scratch Vec into the payload could remove
one n-byte copy without weakening capture; direct bounded canonical staging could
remove another only after exclusive input/lifetime constraints are established.
Neither is implemented here. Reload repeats verified reading and these costs;
keeping the source avoids retaining duplicate canonical bytes, not all host buffers.

### Stage 10: explicit artifact injection into Worker root preparation

The root caller may supply `RootConfig.fileCore = {module, maxFileBytes}`. It is
carried by Webroot into both ready-ahead and first-start messages. The Worker uses
one prepared-tree owner to mount all pack files through the selected storage.
Omission preserves legacy storage; an invalid explicitly selected artifact fails,
never falls back. The first preparation selects ownership. A subsequent request
that supplies fileCore again is rejected rather than silently ignoring a new
selection; starts borrowing the prepared root omit it.

The prepared tree survives rehearsal and kernel exit/free. Worker termination is
its final realm lifetime; there is no new partial-disposal message. Preparation
failure disposes its unpublished file scope, not every translator/transport
resource. Worker memoized failure is not an independent retry guarantee. The
standalone helper can be called anew after a failed preparation.

Verification includes actual Worker-handler rejection paths (with a host message
stub), borrowed tree lifetime across kernel owners, and execution of a minimal
x86-64 ELF from a Rust-backed pack through a real translator. This is not full
muk/container, guest rehearsal, browser Worker or desktop validation. The
translator fixture is an existing historical release artifact whose release
metadata/compressed blob/expanded hash were verified; it is not a build of this
checkout. Tests accept it explicitly via SODS_TRANSLATOR_WASM. The previously
unavailable translator SHA/zstd pack tests pass with that fixture.

Release-index descriptors, generation-aware fetch/cache/progress, build artifact
production and runnable/default deployment selection are not switched yet. No
product receives an unverified hard-coded artifact URL. Copy costs remain stage9's
3n; no optimization or end-to-end performance improvement is claimed by this step.

### Stage 11: release-selected artifacts and normal boot selection

The release builder accepts `--file-core PATH [--file-core-limit BYTES]`. Explicit
missing/malformed flags or incompatible artifacts fail before root reading/output.
It validates imports, required exports, ABI 4 and an empty-file smoke, then uses
the existing content-addressed gzip blob writer. Index.fileCore binds compressed
hash/size, expanded Wasm hash/size, ABI and per-file limit; the index digest changes
with that selection, and artifact pruning retains its blob. Core compilation is
still an explicit Cargo build step, not an implicit toolchain download.

Browser root loading resolves the current verified index's descriptor by default,
then passes the module into the existing prepared Worker path. The speculative
Plan may supply translator/hot caches but never selects a core; core loading occurs
after current-index verification on every load, including a plan hit. Its blob is
included in the live cache set and progress accounting. Missing descriptor alone
means legacy release compatibility; null/invalid descriptors, missing/corrupt blob,
wrong expanded digest, missing exports or mismatched ABI fail without fallback.
An additional caller override conflicts with release ownership and is rejected.
Node runnable uses the same descriptor resolver and prepared-tree selection.

Validation instantiates a throwaway core; the Worker/child later creates its owned
instance. This extra startup work is not hidden in a compile-only claim. Scope
lifetime remains Worker/child realm, not a per-kernel exit cleanup. Resource totals
and source copying retain the prior limitations.

Focused integration builds an actual tiny release via the layers CLI, reads its
index/blob through openWeb, selects Rust without an explicit caller override,
mounts/reads the pack and rejects a missing declared blob. It uses the verified
historical translator fixture with no hot AOT work. This is not a full distribution
build, browser-cache/Worker end-to-end test or runnable muk guest run. No artifact
has been published or registered. Full generation-aware browser integration and
production release/deployment remain verification work, not completed claims.

### Stage 12: historical full-root runnable verification; browser gate blocked

An opt-in runnable integration now verifies a supplied historical release's full
pack set, creates a separate descriptor-augmented fixture, and invokes the actual
runnable child. It neither rewrites the source release nor publishes the fixture.
The local v0.6.5 fixture passed all 68 packs / 11,568 files (141,327,582 stored
bytes). A descriptor-verified muk ran `/usr/bin/true` on the legacy root, and ran
`/usr/bin/sh -c 'printf core-ok'` on the Rust-selected root with status 0, exact
stdout and no stderr/error. Both runs were inline and sequential. Different
commands and historical binaries do not establish a performance comparison or a
new-source full distribution build. The fixture's core was this branch's ABI4;
translator/muk provenance is the existing distribution metadata, not a rebuild.

A real headless-browser Cache Storage harness was attempted separately. Chromium
failed before opening a page because its internal socket syscall was denied by
the execution environment. The approved expanded-execution attempt failed at the
same boundary. No settings bypass or desktop/PC takeover was used. Real browser
cold/warm cache, generation changes and missing-core behavior remain unverified;
passing Node/Worker-handler tests are not substituted for those results. The
experimental browser harness is not part of the committed regression suite.

### Input ownership transfer (ABI4 semantics retained)

New-file creation and a successful lazy completion can adopt the already-written
input scratch allocation. Admission checks precede ownership transfer. Creation
failure leaves the native caller's Vec intact. Lazy completion shares the existing
validation/retirement helper: stale completion cannot retire another attempt;
matching failure/poison retires for retry without publishing; a closed file rejects.
Only the successful payload-producing step takes the Vec. Existing borrowed callers
retain the copying path and the same failure semantics.

The Wasm adapter chooses transfer only when scratch capacity equals length. A large
historical scratch allocation followed by a small file instead takes the existing
copy path, so the optimization does not pin that excess capacity into every small
inode. This is Vec's reported capacity, not a claim about allocator size classes or
RSS. A transfer empties scratch and consumes its input permission; subsequent input
or reads obtain scratch independently. A rejected attempted completion still consumes
the ABI input permission as before, while retaining the buffer. Read leases continue
to prohibit competing mutations. Raw exported memory remains an unsafe private ABI:
a caller retaining writable views across mutations is not a supported embedding.

For n bytes entering the core facade, successful exact-capacity transfer removes the
scratch-to-canonical n-byte copy. The facade's host snapshot and host-to-Wasm copy
remain, so this portion changes from 3n to 2n copied bytes, not zero. Scope.writeFile
may make an additional host capture, and pack decoding/integrity, read scratch,
mapping baselines and output are separate costs. Write-in-place still copies. A new
scratch allocation may be needed after transfer. `files_input` zero-initializes new
scratch before the host fills it. For repeated equal-size inputs that previously
reused scratch, those n zero writes can replace the removed n copy writes; copied-byte
reduction alone is not a reduction of all memory traffic. Transfer avoids coexistence
of separate scratch and newly copied payload at publication, but other live files,
allocator retention and read scratch still count. Allocator work and process RSS are
not inferred from copied-byte counts. The high-capacity fallback still uses 3n.

Native tests verify pointer preservation (no payload relocation), empty/oversize
input, borrowed/taken failure parity and retry. Actual Wasm tests verify scratch
consumption, high-water fallback, stale/poison completion and independent inodes.
This is evidence for the selected ownership mechanism, not a measured application
speedup or proof that the whole runtime reaches a universal resource lower bound.

### Explicit finite-lifetime regular-file creation

`scope.createVfs()` selects Rust payload creation for host `writeFile` and guest
O_CREAT/regular mknod in that kernel's pathname namespaces. This is a concrete
internal Vfs policy, not a callback factory supplied to core syscalls. Default Vfs,
Worker preparation, devices/Fifo/generated files, memfd and shared-anonymous mmap
are unchanged. No existing inode is silently converted. Creation through a mounted
namespace follows the creating kernel/Vfs policy, so the selected scope must outlive
other kernels or host users that acquire those inodes.

This explicitly advances independent sods use, not whole-kernel ownership. The scope
still retains unlinked/replaced inodes until disposal; fd close is not inode death.
There is no aggregate capacity or count budget. Do not enable this by default in a
long-lived Worker before namespace/FD/mapping/image references and failed unpublished
creation have deterministic retirement. Shared-anonymous mmap separately needs payload
admission before its destructive reserve/zero step; memfd/SCM_RIGHTS needs the full
sender/receiver lifetime contract. Those paths are not opted in by this change.

Tests exercise limit/closed rejection, previous fd after path replacement, regular
mknod and Fifo exclusion, and failed explicit-helper namespace publication cleanup.
The independent npm tarball test now executes an ELF doing open/write/close through
both inline and Node CPU Worker schedulers and verifies the created Rust-backed file.
It uses the explicitly selected historical translator, not a current-source translator
build. The full existing runtime suite has separate skipped cases needing unavailable
compiled programs/toolchains; focused success must not hide those skips.
