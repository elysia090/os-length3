# Inode lifetime before long-lived default adoption

This is a design gate, not implemented automatic inode reclamation. Current
`loadFileScope` is the owner of every created payload until explicit disposal.
`createVfs()` remains opt-in and finite-lifetime. No new default is enabled here.

## Roots and transitions

| Holder | Acquisition / publication | End / exceptional obligation |
| --- | --- | --- |
| Creation owner | Rust slot allocated, before namespace or Description publication | Failed unpublished creation must close payload and remove host source callback. Successful publication transfers responsibility; failure after publication is not automatically rollback. |
| Namespace | Each actual directory entry, including hardlinks and mounted/shared trees | Replacement, unlink, clear, mount/tree retirement. Count actual ownership edges, not `nlink`. Existing raw Entries and `Vfs.writeFile` do not maintain regular-file nlink uniformly. |
| Open description | Constructor through installation, duplicated/inherited descriptors | Last Description release, including SCM_RIGHTS queued/in-flight ownership and cycle cleanup. `refs=0` before install is not death. |
| Mapping | Shared mapping publication, clones and partial-map splits | Settle before normal detach; abnormal abandon must release ownership independently of writeback success. Partial unmap currently detaches old record before publishing suffix/prefix: retain a transition owner across the gap. |
| Executable/image | `prebuilt`/image cache and deferred `readLater` closure | Active process, retained Image, pooled instance and deferred source must all finish, or transfer to an independent captured source. Cache deletion/`ended()` alone is not proof. `ended()` currently only removes a loaded-file keeper. |
| Load / operation | Before invoking loader or starting a pending operation | Return, throw, cancellation or poison completion retires operation once. Reentrant close must prevent late success from resurrecting a slot; do not wait synchronously for one's own callback. |
| Embedding owner | Returning raw File/Kernel/Vfs/Image, or exposing their mutable maps | Existing API has no return-of-ownership event. The conservative root is sticky until scope disposal. A caller dropping a JS variable is not observable deterministic release. |
| Loaded-file accounting | `Loaded.files`/keepers track reloadable resident bytes | Accounting membership is not a payload owner; it must not accidentally create a permanent ownership cycle. Separate eviction from inode death. |

Public mutable fields and Maps also allow bypassing wrappers (including borrowed
Map methods). This is not a closed ownership graph. Adding counters to the usual
syscalls while leaving those routes exposed cannot prove reclamation safety.

## Decision and smallest next contract

Do not close on `nlink == 0 && fdRefs == 0`, or on temporary zero mapping count.
The real-Wasm `core-lifetime.test.ts` preserves hardlinks, unlinked fd-less split
mappings, raw host use after unmap, and an unlinked image's deferred source.
The image test uses a minimal metadata module, not execution of a translated ELF.

Three alternatives:

1. Keep finite scopes. Compatible and simple, but retains historical payloads.
2. Scan known roots periodically. Cannot see arbitrary escaping JS handles; a
   complete scan is at least proportional to inspected roots, not a constant-time
   last-owner transition. Not an automatic-reclamation proof for current API.
3. A managed consumer entrance with explicit ownership and no raw mutable graph.
   Track namespace/description/mapping/image/operation roots, and give embedding
   users a releasable lease or a copied value. This is the candidate for long-lived
   defaults, not a silently compatible replacement. Legacy raw escapes keep a
   sticky scope root, so mixing the APIs cannot regain deterministic reclamation.

First close the creation transaction: a pending owner either publishes exactly
once or aborts exactly once. Do not let post-publication open failure delete a
successfully created file. Explicit writeFile already aborts rejected publication;
explicit lazyFile now follows the same rule and retires its source callback.
This covers rejection before insertion. An embedding override that inserts or
moves the inode and then throws is not a supported transactional publication
contract. O_CREAT/regular mknod, scoped Vfs.writeFile and pack mounting now use the same
internal PendingFile transaction as explicit writeFile/lazyFile. PendingFile is
not added to the public linux entrance. The legacy factory still returns a File
and is wrapped without taking away its existing owner; the Rust factory carries
a retirement action. abort changes state before cleanup, is idempotent, and
cannot retire a successfully published file. Publication plus cleanup failure
preserves both errors. This proves neither reference ownership after publication
nor safety of arbitrary overriding createFile implementations. The transaction adds
one O(1) short-lived host owner object per creation, without scanning other inodes
or copying payload bytes. It does not lower the scope's published-inode retention.

Then implement the managed root transitions, including install-before-release
for rename/mapping split, pending read ownership through cancellation, and
SCM_RIGHTS cycle handling. Test each final release and every failure point with
actual Wasm before replacing the existing scope root. In particular, do not
infer image death from the translation cache: images and deferred closures escape.
No automatic GC/finalizer substitutes for the explicit release proof.

## Resource lower bound and remaining storage gate

For live canonical payload lengths n_i, retained payload storage is at least
sum(n_i) for this dense representation; mappings, immutable source caches, dirty
baselines, accepted inputs and scratch are separate. Holes may justify a different
representation, so this is not a universal filesystem lower bound. A bounded
ownership scheme also needs O(live inodes + live ownership edges) metadata, with
O(1) edge updates possible only when all transitions are known. Exact last-owner
reclamation itself needs no payload scan or copy. GC timing is not such a bound.

Current finite scopes instead retain historical inode payloads, not only live
ones. Even after correct payload close, Rust `Files.files: Vec<Option<Slot>>`
keeps one slot per ever-created ID and does not reuse IDs. Thus the metadata high
water and ID exhaustion are an independent long-lived gate. Alternatives include
live-only monotonic-ID indexing (lookup/allocation cost) and generation-checked
slot reuse (stale-handle proof, generation exhaustion). Neither is selected here.
Wasm memory pages also do not shrink on close; payload release permits allocator
reuse, not a claim of returned process RSS. A count/byte admission limit bounds
failure, but is not a substitute for reclaiming dead inodes.

These gates apply to independent sods and ricebox equally. memfd/SCM_RIGHTS and
shared anonymous mapping remain separate admission/lifetime work. They matter
for a future guest Wayland buffer path, but do not prove native everyday session
compatibility or turn terminal artwork into a product architecture requirement.

## Managed entrance and slot-index decisions still to make

A future managed caller must not obtain Vfs, File, Kernel.images or mutable
namespace Maps. Its commands should return copied data or explicit owner handles;
closing a handle invalidates it, not a file still owned by another handle/name/map.
The worker owns the session; separate sessions sharing a tree acquire a tree owner
before use and release it after their operations, mappings and images finish.
Admission failure cannot publish a half-open handle. A delayed load completion
must carry both inode identity and operation identity, not just a recycled slot.
Legacy raw escape is sticky, not undone by closing an unrelated managed handle.
This entrance is a proposal, not a second runtime API implemented in this change.

For C total creations and L currently live payloads, the present slot vector uses
O(C) records even if every close succeeds. Live-only monotonic-ID indexing can use
O(L) records with no stale-ID alias, but still exhausts the finite ID space and
changes lookup cost. A reusable slot plus generation can use O(L) active records
only if historical vacant slots can be bounded; a monotonically growing vacant
list still has a high water. Generation wrap must reject rather than alias an old
handle, so finite-width reuse does not permit unlimited churn. Any index strategy
must also preserve pending-read/load identities and stale completion rejection.
No new public promise of unlimited operation or shrinking Wasm memory follows.
The next comparison must include these retained metadata costs and failure modes,
not select reuse solely because a counter test reports fewer allocated payloads.
