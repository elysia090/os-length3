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

Current finite scopes still retain historical inode payloads, not only live ones.
The lower-level Rust store now removes closed slots from a live-only hash index;
this does not supply the missing close events in those finite scopes. The index
uses monotonic IDs with deterministic std hashing of internal integer keys, no
host entropy imports, and fallible reservation before payload ownership transfer.
IDs never reuse and close remains idempotent for previously issued IDs. Finite
file/load/read identity exhaustion remains explicit; it is not reset by close.

This removes one permanent slot per past creation. Hash-table capacity and allocator
retention may stay at a live-set high water, with rehash/tombstone work on churn.
Native tests cover 10,000 one-live and 64-live rolling creations, stale lookup and
last-ID exhaustion without consuming rejected input. The current debug Wasm's
200 warmup + 10,000 empty create/close trace stayed at 1,179,648 memory bytes.
That is artifact-specific evidence, not a universal peak bound or RSS measurement.
Hash lookup costs more work than direct vector indexing; no speedup is claimed.
BTreeMap lacks the needed stable fallible reservation entrance, while generation
reuse would change stale/identity contracts without solving finite exhaustion.

Wasm pages do not shrink on close; payload release permits allocator reuse, not a
claim of returned process RSS. A count/byte admission limit bounds failure, but
is not a substitute for reclaiming dead inodes.

These gates apply to independent sods and ricebox equally. memfd/SCM_RIGHTS and
shared anonymous mapping remain separate admission/lifetime work. They matter
for a future guest Wayland buffer path, but do not prove native everyday session
compatibility or turn terminal artwork into a product architecture requirement.

## Managed entrance and remaining slot-index conditions

A future managed caller must not obtain Vfs, File, Kernel.images or mutable
namespace Maps. Its commands should return copied data or explicit owner handles;
closing a handle invalidates it, not a file still owned by another handle/name/map.
The worker owns the session; separate sessions sharing a tree acquire a tree owner
before use and release it after their operations, mappings and images finish.
Admission failure cannot publish a half-open handle. A delayed load completion
must carry both inode identity and operation identity, not just a recycled slot.
Legacy raw escape is sticky, not undone by closing an unrelated managed handle.
This entrance is a proposal, not a second runtime API implemented in this change.

For C total creations and L currently live payloads, the previous slot vector used
O(C) records even if every close succeeded. The selected live-only monotonic-ID
index holds L entries, but retains table capacity, still exhausts the finite ID
space and changes lookup cost. A reusable slot plus generation can use O(L) active records
only if historical vacant slots can be bounded; a monotonically growing vacant
list still has a high water. Generation wrap must reject rather than alias an old
handle, so finite-width reuse does not permit unlimited churn. Any index strategy
must also preserve pending-read/load identities and stale completion rejection.
No new public promise of unlimited operation or shrinking Wasm memory follows.
The next comparison must include these retained metadata costs and failure modes,
not select reuse solely because a counter test reports fewer allocated payloads.

## Actual caller audit before a managed entrance

The first candidate is the existing ricebox Worker command boundary, not a new
runner API. Messages carry copied values/modules, not File or Kernel objects.
Inside that realm, however, current code still has the following raw consumers:

| Actual caller | Required operation/result | Ownership that must not be lost |
| --- | --- | --- |
| `prepared-tree.prepareTree` | Mount root, apply given files, install muk; currently return raw Vfs + dispose | Public callers retain an unrestricted graph. Preserve this API as finite/raw; do not silently make its files collectible. |
| Worker `ready` / `rehearse` | One prepared tree shared across rehearsal and subsequent execution | `readied` owns tree across runs. A kernel borrows it, not owns it. Rehearsal error is caught; a timer/failed notification is not proof every kernel reference ended. |
| Worker `follow` / `runs` | Install ready translation, adopt extra modules, observe future code | `kept[]` retains Image independently of the kernel image cache. An observer has a lifetime and cannot be reduced to a path: the path may now name a replacement inode. |
| Worker `told` | Observe newly translated root code and later modules; send bytes and origin/path identity | Needs a prepared publication and explicit consumption outcome, not raw Image fields. Current code changes `wasm/mainTold` before sending; transfer/send failure and retry must be defined before introducing an owner release there. |
| Worker idle consolidation | Is work due? Consolidate idle translations, then publish observations | Needs a query/operation, not mutable `due` Map. Old images can still be running/observed after consolidation. |
| Worker `Mirror` / `given` | Observe file changes; apply files/hot programs | Returned bytes can cross the boundary as copies. Mirror's retained File identities and replaced hot images remain roots until observer retirement. |
| Independent sods tarball example | Explicit scope+Vfs, linux returns Kernel, run, then dispose | Valid finite-owner path; it does not certify the future managed entrance. Keep it working and explicit. |

Consequently, adding a `managed` boolean to the public Vfs or wrapping linux() while
still returning Kernel would hide, not close, the graph. Avoid both. The existing
Worker's private implementation may later own a managed tree, but only after its
raw uses above have been replaced by the required operations and ownership events.
No new public managed type or parallel runner is introduced now.

For the private owner protocol, the tree owner survives every run; each kernel,
translation observer and active operation acquires a separate borrow before use.
A stop request changes admission first, rejects new borrows, then waits for actual
termination/operation retirement. It does not infer drainage from status, a sent
error message, `ended()`, or RemoteKernel.close(). Namespace roots survive run end.
At realm termination the whole graph is discarded, currently the only already
closed Worker-wide boundary. Before then, final inode release requires all of the
edge transitions in the table above and the earlier root table, including cycle
cleanup and mapping split guards. A borrow count around just `spawn()` is not enough.

Additional actual-Wasm counterexamples now remove an image from Kernel.images and
call ended(), then read its still-valid deferred source; raw Entries mutations also
show two or zero real namespace edges with an unchanged nlink of one. These tests
reject premature last-owner rules. They do not establish final-owner reclamation.

Worker follow/told now use a private TranslationObserver. Its tracked records own
Image observation references; individual close nulls that record's Image, global
close releases all observations, and neither closes executable images or files.
Root publication progress remains the existing Image mainTold/told fields as one
source of truth, including keeper seeds and fresh consolidated Images. Ordinary
run end still does not close the realm-owned observer: late code/shared preparation
have not acquired a stronger lifetime proof.

Each message captures bytes/identity and an extras end index before send. Successful
return acknowledges only that prefix; main wasm is cleared only after acceptance.
The existing more/translated/reached message shapes and ordering are retained.
Failure behavior is intentionally stricter: any publication exception permanently
fails that observer, preserves the already-accepted prefix, and permits close but
no retry/new tracking. A send may transfer bytes and then throw, so unacknowledged
is not proof of no external effect. Local acceptance is not receiver persistence
or exactly-once delivery. No automatic retry is added. Reentrant publish/track is
rejected; close during send permits that accepted prefix but stops subsequent sends.

The private helper snapshots root entry identities once (O(number of image entries)
transient host records); this bounds an iteration even if a sender mutates the map.
Extras/segments keep the existing byte copies and main wasm transfers its original
buffer. It does not scan/copy file payloads. Hash indexing/observer extraction is
not a claim of whole-system resource optimality. Tests cover same-path old/new
images, consolidation/keeper seeds, late extras during send, partial failure,
transfer-then-throw, close, and a real Rust-backed deferred source after observer
close. The latter explicitly remains usable: observation ownership is not total
Image/inode ownership.

Next gate remains namespace/fd/map/image/operation ownership for a managed tree.
Moving raw Image accesses into this private helper alone does not prove final
reference reclamation; the current Worker keeps its observations for its realm
and the raw public kernel/tree APIs stay unchanged.
During send, appending extras and closing observation are supported; arbitrarily
replacing the same Image's wasm/mainTold/told/origin is not a revision transaction
provided by this helper. The consolidation-shaped test uses two distinct Image
objects and seed values; it does not execute the actual consolidation compiler.
