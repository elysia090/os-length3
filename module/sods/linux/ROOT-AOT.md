# Managed readonly root and prepared image

## Selected caller, not a new default Kernel

`managedRoot(core, {memories, actions})` is an additive, asynchronous entrance in
`sods/linux`. It selects the reviewed Linux Node 22/24 fixed-memory, one-runner,
readonly prepared-root profile. The existing `linux`, `preparedLinux`, Kernel,
RemoteKernel and browser backend selection remain unchanged. No syscall falls
back individually into that TS Kernel.

The facade exposes only `prepareRoot`, `rootSource`, `pathExecution`, `runPath`,
`stopWorker`, `workerSettled` and `workerEvidence`. There is no raw core, Memory,
Global, arbitrary inode open, grow or diagnostic runner. The implementation is
loaded only when explicitly selected. A selected obsolete Linux core fails its
required-export/version check, never silently chooses another owner.

The supplied module must be the **trusted matching Linux core**. Its private ABI
is 6, independently of file-store ABI4. Export shape and version do not prove
arbitrary Wasm provenance. The current managed caller remains static/non-TTY and
is not an ordinary utility, shell, muk box, full VM or terminal compatibility
claim. The low-address Worker FS subround is covered by
[TLS-CALLER.md](TLS-CALLER.md); the single-task218/231 contract is covered by
[TASK-CALLER.md](TASK-CALLER.md). Shared guest mm and owned sendfile remain
separate implementation gates.

## Input and ownership

The producer authenticates a captured root index and supplies its generation.
Ricebox's `runtime/managed-root-wire.ts` encodes its stored metadata into neutral
`SODSROOT` wire v1. This is a selected range-backed immutable-root preparation
contract, not a universal archive or live-host-root importer. The Rust wire
schema is documented in `src/prepared_root.rs`.

Rust owns byte path/component checks, directory parents, collisions, inode and
hardlink identity, canonical SourceIds, artifact associations and atomic sealing.
It does not walk a live TS Vfs or accept TS-resolved guest inodes. All fallible
construction stays private until tree, catalog and mount bootstrap are ready.
Failed sealing consumes staging without publishing a partial namespace. There
are no payload callbacks or guest/Worker starts during metadata construction.
The 16 MiB input limit is checked before the adapter's owned copy as well as by
Rust; logical record and per-file limits are not exact allocator/heap bounds.

The profile is root-owned uid/gid0. Names are byte paths encoded from the stored
strings, not arbitrary host filename-byte preservation. Nonempty equal stored
regions `(blob ordinal, offset, stored length)` declare one hardlinked inode;
zero-stored-length files stay distinct. Conflicting grouped metadata and duplicate
blob digests reject. These are deliberate selected-format restrictions, not full
legacy mount-format equivalence. Root initialization does not permit overlays.

A SourceId is nonzero, stable and local to one root/core incarnation. `rootSource`
returns only fixed transport coordinates. It does not resolve guest paths,
authorize access, advance offsets or issue a read. A loader must stay bound to
that same root owner/generation, not route bare numeric IDs across roots. Empty
resident files have no lazy-source request.

The integrated Linux Files store is the single canonical payload owner. The
same selected execution does not also import those bytes into standalone
file-store or a second TS inode graph. The default compatibility branch remains
until its actual callers migrate.

## Source-ready and image-ready are different

`Files::prepare_program` resolves and authorizes the exact program using Rust
credentials and mount policy, captures execfn, and holds its Place without reading
payload. Its metadata identity is canonical inode incarnation, SourceId and size.

The fresh path completes source delivery before `ReadyProgram` and translation.
The prepared path retains `Program(Reserved)` in one artifact-preparation job,
then creates a distinct `ImageProgram` on its matching stopped receipt. It never
sets source-ready artificially, supplies an empty ELF, or calls the loader merely
to reach image construction. Both paths converge on the existing image/stack,
credentials and observed-stop ownership protocol.

A prepared association is bound to that **authorized canonical inode**, source
identity/size, captured generation, artifact and translator descriptors and
preparation mode. A pathname replacement, equal size, origin string or reused FD
cannot retarget it. Hardlink aliases share exactly one consistent association;
foreign inode incarnations and contradictory associations reject.

`pathExecution` accepts a `preparedArtifact` transport callback, not a compiled
Module plus separately supplied segments or facts. Its frozen request contains
root generation, SourceId/size, source digest, stored artifact/translator digests
and shared mode. The transport authenticates the requested stored artifact and
returns its decoded Wasm bytes. Those bytes are captured into one private owned
built-in typed-array snapshot; shared backing is rejected. The same snapshot feeds
module framing, custom facts and external segment preparation. No writable views
or fabricated prepared flag are exposed as a capability.

The managed validator still excludes start functions, own memory, unexpected
imports and retained data in the externally initialized image. Numerical facts,
segments and stack bounds are checked before the physical Worker image is
committed. Those checks do not prove arbitrary generated code implements a
claimed ELF. Original stored-blob hashes also do not rehash the transformed
shared/no-data Module.

## Integrity and later demand

Generation is the authenticated **index JSON** digest. Source digest is the
producer's raw ELF digest. Artifact and translator descriptor digests currently
name **stored compressed blobs**, not their decoded/transformed Modules.
Association consistency is not independent compiler-correctness proof.

Pack transport authenticates stored tables/regions and decodes them. Rust does
not implement this cryptographic/decompression work. Exact root lazy files also
enforce their declared decoded length in Rust: a matching wrong-length success
settles as failure without adopting bytes or changing canonical size; stale or
late completions cannot consume another active attempt. General provisional-size
`lazy_file` behavior remains separate and unchanged.

AOT admission may leave canonical ELF completely absent. A later ordinary
open/read/self-read uses the same Rust OFD, SourceId and matching lazy attempt.
`runPath(execution, load)` forwards that physical source service; it adds no TS
path, credential, inode, FD or offset authority. The service must preserve stored
integrity and decoded length for that exact root.

Translation miss is still denied by the managed guest. Retaining a source does
not implement `Image.more/readLater`. The first utility must demonstrate its
admitted no-miss closure, or a separate source-held miss/translation/installation
coordinator must be completed. Default canonical-aot-v1 compile-failure fallback
is unchanged; this new prepared path requires its valid selected association
and does not silently fall back to fresh bytes or TS execution.

## Failure and retirement

- A cancelled artifact job retains its selected Program until the callback and
  private preparation settle. Late success cannot publish a live image.
- Invalid bytes, Module/shape-only lookalikes, shared input or malformed image
  data fail before Worker publication. The job receives one failure receipt;
  completion is not replayed if a receipt itself fails after changing state.
- Physical image Unknown keeps its obligations. A termination request or thrown
  compile/initialization error is not an actual stopped Worker certificate.
- Live publication followed by reply loss is not undone or replayed. Executable,
  table, source and binding owners remain until the independent required receipts.
- `stopWorker` requests stop. `workerSettled` only settles host requests;
  `workerEvidence` separately reports observed exit and resource retirement.
  Retain the root/host and outstanding handles until those obligations end.
- Root lifetime exceeds individual runs. Execution retirement does not free the
  root, cached artifacts or all physical memory/domain capacity. Repeated runs
  are bounded by explicit admitted capacities, not unlimited reclamation. The
  initial `memories` quota bounds both binding records and non-reused admission
  history: a failed pre-image startup still consumes an admission record. Table
  and FsContext capacities are separate and must be returned after cleanup.

## Verification and remaining gates

`module/ricebox/runtime/test/managed-root-wire.test.ts` checks producer encoding,
limits and byte preservation. `managed-root-current.test.ts` connects that wire,
the actual current Linux Wasm and translator, private image preparation and a real
Node Worker. Its fixture AOT is generated before the source-free startup window;
that preparation is not confused with zero total ELF processing.

Rust owner tests cover malformed/overflowing records, parent symlinks, hardlink
and empty-file identity, foreign associations, exact-size/stale delivery,
source-free image ownership, cancellation, invalid facts and Unknown image
retirement. Full strict TypeScript, independent packaging, existing runtime/CI
and actual browser budget still apply; local component probes do not replace them.

The standard BusyBox `cat` target additionally requires owned sendfile beyond
its admitted open/openat, low-address ARCH_SET_FS and single-task registration/exit
bridges. Its transfer owner must
retain both exact OFDs and commit only a known stopped prefix. In particular,
zero count or source EOF is **not** endpoint-agnostic sendfile success: controlled
native FIFO cases can still produce EAGAIN or EPIPE/SIGPIPE. A physical stream
capability, signal/error scope and Unknown/no-replay protocol must be established
before claiming that caller. No such full utility compatibility follows yet.
