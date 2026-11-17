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

## Source capture and observation are different owners

`readLater` now explicitly holds a nullable pending File reference. A failed source
read leaves that reference for retry; successful capture checks the revision, stores
the independent/COW byte view, and clears the pending File reference. Later calls
use only that captured view. This removes the closure's logical File edge after
capture without closing the file or changing any public Image properties. The
Rust regression covers load failure/retry, later inode mutation, cache removal and
scope disposal after capture, then reuse of exactly the captured byte object.
It proves the captured path does not access the disposed owner, not that GC runs
or that other owners of the inode have ended. Captured bytes remain resident.

An observation still holds an Image, and uncaptured images still need their File.
A publication-only record could eliminate that extra observation→Image/source edge:
it would own extras, segments, origin/changed and publication progress, with no
back-pointer/getter capturing Image. An immutable snapshot alone cannot follow late
code; event subscriptions add ordering/failure/unsubscribe contracts. The shared
record is the smallest candidate, but normal Image property access and reflection
compatibility must be assessed before replacing public mutable fields with accessors.
It has not been silently implemented here. Same-path replacement/consolidation
must produce independent records, and source revision invalidation must still reach
the old record. Returning a record must not give a caller authority to close a file.

For final inode close the conjunction remains: no actual namespace/mount owner,
no installation/in-flight/live Description, no mapping or split transition, no
uncaptured image source or exe identity owner, no active load/read/copy operation,
and no raw embedding/scope owner. Removing the captured-source edge or closing the
observer proves only one component of that conjunction. No new per-inode counter
or long-lived default is enabled until these ownership transitions are connected.
The capture regression also passes the former cached-view behavior; it protects
functional compatibility, not a measurement of reference collection. Removal of
the pending edge is established by the explicit nullable state change in source.

## Descriptor retirement is not inode destruction

The next bounded step uses existing explicit retirement, not a new root counter.
Description terminal release now marks closed before callbacks and is idempotent
on reentry. Each independent finalizer is attempted despite another failing;
multiple failures are reported together, with a single original error preserved.
FdTable closeAll/exec capture slot identities, attempt all selected retirements,
and report failures afterwards. A finalizer may close and reuse a later fd number;
that newly installed slot is not part of the original selection and is not closed
by mistake. No unbounded loop tries to drain arbitrary callback-created slots.

This preserves dup/shared-table ownership: no final release before the last real
Description reference and last table holder. Existing SCM_RIGHTS retain/release
and cycle handling still apply. It does not clear a closed Description's raw node
field, close any File payload, or claim that a caller retaining a raw Description
has relinquished it. Namespace/mapping/image/source and external roots are separate.
The change adds only slot-identity snapshot checking and lazy error arrays; it adds
no payload scan/copy and does not change syscall lookup into Rust. Aggregate errors
are an exceptional outcome, not silent successful retirement.

Process-level cleanup was a separate gate: exitProcess marked a process zombie
before unmapShared, so failing dirty publication skipped later fd cleanup. The
continuation below now addresses that case only after task termination succeeded.
Neither fd-table finalizers alone nor this continuation authorize managed/default
inode reclamation.
An attempted finalizer can itself stop partway (for example inside socket.close);
this step does not repair every nested finalizer or certify complete drain.


## Process retirement after existing task-end calls return

The continuation begins only after written-range capture, instance handling and
every existing endTask call returns without error. It then retires each of the exiting process's
mapping observations independently: attempt writeback, abandon that observation,
update sharing flags. A failed mapping cannot prevent unrelated mapping retirement
or fd/fs/vfork cleanup. Failed dirty bytes are explicitly not recovered; successful
prior/sibling publications remain. Other processes' mapping records remain owners.
The process's memory reference is cleared once before letGo, whose existing users
count still prevents recycling shared memory while another process owns it.

Each independent continuation phase records failure and proceeds. The original
single error is preserved; multiple errors, including cleanup failures, are returned
in an AggregateError. Successful child/namespace terminal bookkeeping proceeds, but a failed
init retirement does not emit the normal stopped callback. Its requested exit status
remains recorded; the thrown error means cleanup failed, not a successful writeback.
A reentrant exit sees zombie state and cannot release the same owner twice.
Any recursive child-exit failure conservatively stops parent tree clearing while
preserving prior parent errors. Thus a child whose backend failed to stop is not
removed from process/scheduler ownership records. Surviving shared-memory owners'
SHARES hint is not unconditionally zeroed by the exiting process.

The real-Wasm regression uses Rust payloads with two processes sharing one execution
memory, a failed dirty mapping, an independently successful mapping, a failing fd
finalizer and reentrant exit. It verifies survivor ownership, memory.users, canonical
bytes and error identity. The process fixture supplies memory/layout directly; this
is not a translated guest program inducing a storage fault.

A task/backend stop failure is deliberately not swallowed by this continuation.
Unknown running threads must not race memory reuse. The existing failure leaves
memory attached and does not enter letGo; a separate injected-endTask test checks
that conservative guard, not actual CPU Worker termination. Complete cleanup after
such a stop failure, initial written-range failure, and nested finalizer failures
remain separate gates requiring quarantine/realm termination evidence. No claim of
fully drained arbitrary raw callbacks or universal process shutdown is made.

This does not strengthen the backend's stop acknowledgment. RemoteTask.end already
marks memory tainted when terminating a Worker that may still write briefly;
letGo retains its existing no-reuse treatment for that memory. The new continuation
is not a proof of an atomic snapshot of all writes during asynchronous termination.

## Worker stop request versus stop completion

RemoteTask now taints execution memory before lookIn or the forced stop request.
A synchronous failure in either operation therefore cannot leave that memory
eligible for pool reuse. It does not release the GIL in a new finally block:
unknown running code is not evidence that another execution can safely proceed.
The assignment is detached as before; a terminal end guard makes subsequent close
neither an implicit retry nor a way to reach GIL release after a failed stop.

RemoteKernel.close snapshots task assignments and spare identities before callbacks,
attempts independent unchanged assignments/spares despite synchronous failures, then
reports a single original error or all failures. A replacement assignment is not
stopped just because the old task occupied that place in the snapshot. Failed spares
cannot enter the warm pool. Newly introduced callback-owned work is not an unbounded
drain target. Snapshot space is O(tasks + spares), no file payload copy/scan is added.

The host contract still has no portable completion evidence. Node's current adapter
discards terminate()'s Promise; browser terminate returns no matching Promise here.
This change captures synchronous exceptions only, not a later Node Promise rejection.
Awaiting a Node-specific completion could strengthen that one host, but would not
prove browser completion, all channel users gone, or every Image/namespace owner
released. Do not label close() or successful stop requests as a managed-tree disposal
barrier. That API/profile decision remains open, with tainted memory never reused.

The failure tests use injected host hands, not live CPU Worker stop failures. Existing
independent package execution still exercises the real Node CPU Worker path normally.
Neither normal completion nor those injected failures prove an OS-level quiescence
barrier for every supported host. Long-lived default promotion remains withheld.
A repeated terminal end returning normally is only an idempotence guard, never
positive evidence that the first stop request succeeded or completed.

## Host-specific completion evidence (checked 2026-11-16)

[Node v24.22.1](https://nodejs.org/download/release/v24.22.1/docs/api/worker_threads.html#workerterminate)
defines asynchronous terminate completion through the Worker's exit event. That
event identifies a stopped Worker, is its final event, and follows delivery of its
messages. The new host-only test on installed Node v24.22.1 runs an actual Worker
that writes shared WebAssembly.Memory and then enters a wait loop: request return precedes exit, which precedes
Promise fulfillment. A separate natural-exit test observes final-message delivery
before exit. These tests do not use the translated CPU runtime or change disposal.

[HTML's termination algorithm](https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker)
runs alongside the worker loop, sets its closing state, drops queued work and aborts
execution. The browser Worker API supplies no equivalent exit-completion Promise
in this interface. This is not a claim that browser termination does nothing; it
means this host adapter has no affirmative completion observation to use as the
managed resource barrier. Browser memory remains non-reusable under this design;
no browser execution was attempted, and browser completion remains unverified.

### Candidate contract, not implemented production API

Keep request outcome and observed termination as separate dimensions associated
with the specific Hand identity, not whichever kernel currently owns its worker:

| Case | Request result | Observed stop / ownership consequence |
| --- | --- | --- |
| Node request returns Promise | Accepted/pending | Still unknown until matching exit evidence; keep owners and taint. |
| Matching Node exit | May be natural or requested | Stop known for this Worker only. Other process/map/namespace/output owners still block tree disposal. |
| Synchronous throw or asynchronous rejection | Preserve failure for the requesting owner | No inferred completion. If an independent matching exit was already observed, keep that fact as well rather than erasing it. |
| Waiter deadline | Report timeout to that waiter | Remains unknown; retain observation and ownership. Deadline is not permission to recycle or retry automatically. |
| Late exit after timeout | Original waiter timed out | Update host evidence; do not automatically dispose resources whose other owners have not ended. |
| Duplicate request | Reuse original request identity/outcome | Never issue a second termination merely because a waiter timed out or close returned. |
| Already-exited Hand | Do not invent a new stop operation | Use latched matching exit evidence. |
| Browser terminate return | Request made | No Node-equivalent observation; continue isolation/non-reuse, not a fabricated fulfilled ticket. |
| Healthy spare passed on | No termination requested | Ownership transferred to warm/next kernel, not reclaimed or counted as stopped. |

A completion observer must attach before use so it cannot miss natural early exit,
and a waiter timeout must not detach that observer. A Node rejection handler must
be installed when requesting, not later during optional wait; retaining a rejected
Promise without a consumer would create an unhandled rejection. The failure must
reach a defined owner/diagnostic path, not be swallowed to keep tests green.

The minimum next adapter decision is therefore a per-Hand stop observation separate
from end():void, with one request identity, latched evidence and explicit failure
recipient. Changing end to return Promise alone would silently weaken existing
callers that ignore it. No production adapter or managed-disposal API is added in
this evidence-only step. Isolation retains resources and can consume memory; it
bounds reuse risk, not storage. A resource admission limit and a caller policy for
abandoning the owning realm remain necessary for persistent unconfirmed stops.

The host tests have a finite 10-second test deadline; exceeding it is a failed
observation, not evidence of termination. Ready precedes entry into the wait loop,
so the test does not assert the exact instruction where terminate interrupts it.

### First production boundary: per-Worker observation, not tree disposal

The Node adapter now attaches `WorkerStop` before returning a Hand. `end()` still
returns synchronously. Its one request immediately consumes rejection, preserves
request failure independently of matching exit evidence, and routes it through
the existing host-error path (console, task retirement, wake). The current kernel
also retains `stopFailures`; a notification callback failure is separately retained
on the stop record and cannot become an unhandled derived Promise rejection.
A naturally exited CPU Worker is reported as unusable, including an active task;
it is not silently kept as a healthy spare. Requested/exited Hands are excluded
from warm adoption, selection, keep and pass-on. Pass-on clears the owning kernel
without adding a second set of listeners on later adoption.

After matching Node exit, only that Hand's `kept` and `channel` bookkeeping is
released. No kernel, Image, namespace, file-scope or memory ownership is released;
forced-stop memory stays tainted. This is a deliberately small managed-release
step, not permission to call FileScope.dispose or promote long-lived default.
Browser Hands have no fabricated `WorkerStop` observation and retain their existing
conservative isolation. There is no timeout-based release or retry. An optional
waiter can stop waiting without cancelling the host's attached exit observer.

Warm workers with no owning kernel follow the existing warm-error removal path;
the failure remains on their stop record, but a public warm-start diagnostic
recipient is still absent. This is not claimed as complete warm-start diagnostics.
Likewise notification failure does not certify successful process cleanup.
Admission limits for unconfirmed stops and closed ownership of the tree remain
separate gates. Actual Node CPU adapter tests cover stop/bookkeeping and a real
Node shared-memory worker covers termination evidence; they do not prove whole
translated-guest teardown or browser completion.

### Unowned warm diagnostics and the remaining tree-release boundary

`warmThreads({count, failed})` gives newly created warm workers an explicit failure
recipient. Existing numeric calls remain compatible; they do not silently acquire
a global logger. `Apart.unownedWorkerFailure` is the destination a kernel chooses
when passing healthy workers into the unowned warm pool. At that transition the
old kernel reference is cleared, the recipient is assigned, and the existing
listeners are retained exactly once. Adopting a warm worker routes ordinary
failures to its new kernel; passing it on again replaces the unowned recipient.
An already populated warm pool is not reassigned by a later warmThreads call.

ricebox's existing Worker now supplies its existing error-message sender both for
explicit warming and rehearsal pass-on. A failed diagnostic sender is retained
on the Hand independently and cannot prevent warm removal or its stop request.
A later failed stop request remains a distinct failure, even if the original
worker error already marked the Hand failed. Numeric legacy callers and callers
that omit the optional pass-on recipient still have no promised public unowned
notification. No global sink, silent retry, or new error message protocol is added.

The concrete full-tree owner boundary remains the existing ricebox Worker, not
an arbitrary kernel returned by sods.linux. A safe future shutdown must perform
these phases in order; none is inferred from a guest exit code:

| Phase | Concrete owners/operations | Failure rule |
| --- | --- | --- |
| Freeze admission | Worker start/ready/hot/put/kept and idle-consolidation timers | No new operation may acquire the tree while it retires. Already started ready/rehearse work must settle or retain its owner. |
| Retire execution | Every rehearsal and foreground kernel, including detached/failed Hands and healthy pass-on workers | Track the exact identities that may still hold an instance. Node matching exit can end that Worker owner; browser terminate return cannot. Timeout retains ownership. |
| Finish or abandon external effects | Pending output/Mirror reports and translation publication | Preserve send failure and any accepted prefix. Diagnostic failure is not cleanup success. |
| Retire observers and deferred source | TranslationObserver, Mirror, keeper callbacks, old/new Image identities and pending loader/read/translation work | Close each real root, not only current kernel.images. An observer close does not revoke an independently escaped Image. |
| Retire process and namespace roots | FD/SCM_RIGHTS, mappings, filesystem views, prepared tree, raw embedding handles | Abnormal writeback may abandon dirty data but cannot release a still-running reader. Public raw escape makes the finite owner sticky. |
| Final dispose | The finite scope, only after all preceding owners are demonstrably gone | Preserve original and cleanup failures. No disposal after an unknown barrier or a merely emptied registry. |

In the current implementation `readied` owns a raw PreparedTree across rehearsal
and foreground runs; local variables in asynchronous preparation/rehearsal also
own it. The Worker lacks a shutdown/admission state and an owner registry for all
these asynchronous operations. Merely adding a borrow counter around `kernel`
would miss those roots. Likewise recording only workers() at close misses Hands
already detached by an earlier failed stop. These are concrete blockers, not
permission to erase or synthesize ownership evidence.

The next managed step must first close admission and track actual operation/Hand
owners in this private Worker lifecycle, without changing the public raw
PreparedTree contract. Node can subsequently supply a positive stop barrier for
that subset; browser needs a separately verified cooperative ownership-return
protocol or must keep realm-lifetime isolation. Neither a generic managed flag
nor a new runner that still returns raw Vfs/Kernel would solve this boundary.

### Admission freeze and actual operation observations

The private ricebox Worker now understands an explicit `retire` command. It
freezes new admission before invoking callbacks, cancels idle/wake timers, attempts
halt/close for each still-reachable recorded execution kernel, closes translation
observation, and relinquishes its current Mirror reference. The `retiring` reply
acknowledges only that admission is closed; it is not `stopped`, output drain,
cache reclamation, or prepared-tree disposal. Repeated retire does not issue more
halt requests. Existing root/terminal termination callers are not yet changed to
use this command. They retain their previous realm-termination behavior.

Commands, preparation, rehearsal and serve have separate operation tokens. Results
of already admitted asynchronous preparation are recorded before checking freeze,
so a tree completed after retirement is neither published into a new run nor
silently disposed. A single explicit preparedOwner field retains that finite
result even if freeze causes the preparation Promise to reject; successful
readied also refers to it. This intentional late-result root is not a history
of all kernels. Foreground/rehearsal kernel,
observer, Mirror, warm-pool and pending-output observations stay distinguishable.
An outstanding kernel observation is not proof that it is still executing, and a
settled operation is not proof that its cached Images or host Workers stopped.

The lifecycle ledger and execution list are deliberately **non-owning** WeakRef
observations. They do not introduce new strong roots for every historical Kernel,
cache or tree. Actual ownership still comes from preparedOwner/readied, running operations,
current kernel/observer/Mirror and host Hands. Snapshot counts are conservative
unresolved observations, not GC liveness or a collection predicate. Observation
records still consume metadata and can accumulate; this is not zero-cost tracking. Callback
failure records are retained explicitly for diagnosis. No new collector is built
on these counts.

RemoteKernel separately records adopted Hands including those later detached from
tasks/spares. Only matching Node exit removes that record. Browser/legacy Hands
remain unconfirmed; pass-on does not prove that their cached instances released
an earlier kernel's memory. The exit callback references the owner set weakly, so
a healthy Worker passed through successive kernels does not itself keep all past
kernels alive through this added observer. This is not a browser stop barrier.

Tests cover injected retirement reentry, actual asynchronous translator preparation,
and real muk image start with retirement reentered from `threads` publication.
They also cover detached Hand lifetime and no-observation retention. The reentrant
message host is a test double, not a browser execution. Production sends and
admission checks are exercised; browser quiescence, all-root disposal and complete
output draining remain unimplemented.

### Existing browser terminal caller connected, still abort-style

The existing terminal end path now clears its Worker pointer and ordinary message
handler, then calls ricebox's `retireRootWorker` through the existing root entry.
It requests admission freeze and waits at most 250 ms before requesting browser
termination. The UI still ends immediately. A retirement acknowledgement, timeout,
or terminate() return is **not** stop evidence: the returned hostStopped value is
always unconfirmed. Timeout only bounds how long abort waits for admission closure;
it never authorizes memory reuse or FileScope.dispose. Duplicate close requests
share a single attempt. Listener/request/cleanup/termination exceptions are retained,
and the terminal appends failures to its existing ended reason without erasing
the original failure. Stale/restarted-session results are retained diagnostically
but do not redraw or refocus an obsolete terminal.

The Worker includes synchronous cleanup failures in the acknowledgement itself,
so terminating after that acknowledgement does not depend on receiving a subsequent
error message. Synchronous acknowledge-then-throw and repeated/reentrant calls are
tested. The helper is a browser boundary, not the Node Worker exit-observation API.
No real browser session was run; the actual private Worker message handler is tested
against a structural caller double, and live Node CPU execution is a separate test.

This remains **abort-style**, not timing-equivalent to the old immediate terminate.
The new grace period permits additional guest execution/writes until acknowledgement
or fallback handling; a busy event loop can extend it beyond 250 ms. It promises no graceful drain. Late ordinary Worker
messages no longer mutate the ended session. Messages already processed by the UI
and repository writeback work already accepted there are not undone. No promise
is made to flush gathered bytes, receive queued messages, finish repository writes,
or drain output credits before abort. That is the next separate protocol decision,
not a hidden interpretation of `retiring`.

For a future draining close, the specific evidence chain is: stop guest production;
finish or explicitly abandon gathering and Mirror/translation publications; freeze
a final sent-byte/epoch boundary; let the consumer acknowledge receipt through that
boundary; separately await any requested durable repository writeback; then obtain
host-specific stop evidence before disposing the closed ownership graph. Current
`drained(n)` is only output backpressure credit, not a persistence acknowledgement,
and the page can defer it until a render turn. While retire rejects all new messages,
it cannot double as this drain protocol. A separate closing mode must continue to
accept exactly the required acknowledgements and reject unrelated new work.

A correct drain need not copy payloads again: at minimum it retains the outstanding
sent/gathered bytes until consumption or explicit abandonment, and adds completion
metadata/notifications for the final boundary. It cannot be proved by a fixed timer,
by resetting onItsWay to zero, or by treating a postMessage return as consumption.
Browser shutdown may still remain unconfirmed after drain; Node exit proves only
that Worker stopped, not that repository writes or other tree owners completed.

### Separate sink outcomes before introducing a draining close

The existing consumer returns `drained(n)` for old-epoch output it discards as
well as output accepted by `Output.print`. That method can defer drawing to a
later animation frame, and hidden tabs retain only their limited terminal state.
Thus credit returned, model accepted, visibly painted and preserved forever are
four different claims. None says repository changes were stored.

The actual repository sink, why's WriteBack.write, now returns a per-batch receipt.
It waits for the supported store operations and reports storeAccepted, policy
exclusions, budget/store-skipped paths, whether a tab journal was created, unexpected
queue failure and diagnostic failure independently. Store acceptance is not fsync
or permanent durability, and sessionStorage journalling is not a durable receipt.
Unexpected failure can leave a successful prefix; no rollback or safe automatic
retry is inferred. A caller racing a timeout still owns an unresolved receipt.

Existing normal callers keep their previous diagnostic callback and do not claim
a draining close. Notification failure no longer poisons subsequent store work.
A batch blocked by an unexpectedly failed predecessor reports that failure and
returns its capacity reservation. Recovery journals remain ordered by repository,
and unrelated repositories remain independent. The receipt adds no payload copy;
input file objects/paths and byte views must remain stable and undetached until
completion; the API does not promise a snapshot of mutable caller data. Outstanding payload retention
and the existing journal encoding remain real costs, not eliminated by this API.

For the next protocol decision, an **ordered final boundary** is preferable to
adding an acknowledgement for every output chunk: the Worker-to-page channel
already orders messages. After stopping production and completing publications,
a boundary can identify the exact received prefix. The consumer must then wait
for the write receipts captured before that boundary and explicitly classify
output accepted versus intentionally discarded. Later work cannot extend the
boundary. An asynchronous sink result must not be replaced by its queue insertion
or diagnostic callback returning. Any send with an ambiguous external outcome
fails the close attempt rather than replaying possibly transferred bytes.

At this design step the final-boundary message and consumer barrier were still
candidates. The next section implements the normal-exit forwarded prefix only,
not an all-stage draining-close state or tree disposal. It coexists with the
existing explicit abort path; cancellation can abandon waiting, not undo accepted
writes. Browser host-stop evidence remains unavailable even after a future
successful consumer boundary. Node's exit observation proves a different stage.

### Implemented normal-exit prefix boundary (not all-stage drain)

On the existing normal exit path the Worker finishes its local report/send/told
calls, then posts one `output-boundary {sentBytes}` before `exit`. sentBytes counts
only output messages whose local send returned. The flag is set before posting
so an ambiguous boundary send is never retried. While output publication is
active, reentrant execution/publication/boundary establishment is rejected; only
a successful send return commits its byte count. After the boundary, forwarding
output/changes and new application commands is closed; credit and retirement
remain separate controls. Observed later gather bytes are abandoned and reported
on retirement. Unobserved guest writes during host stopping are not counted as
successfully drained data. This is the final **forwarded prefix**, not proof every
host thread is quiescent or every generated byte reached the page.

The page distinguishes byte views handed to its terminal model from intentionally
discarded old-epoch output. Both repay credit, but only their separate counts enter
the prefix result. At the ordered marker it snapshots the already accepted
WriteReceipt operations and waits for those results. It rejects subsequent output,
changes and duplicate boundaries rather than silently extending the prefix.
The result reports exact received-prefix agreement, accepted/discarded byte totals,
store acceptance, exclusions, incomplete batches and diagnostic failures. It does
not say pixels were painted, data was permanently durable or the Worker stopped.

Explicit stop/error paths that have no boundary remain aborts; they do not invent
a successful drain. Host retirement can proceed concurrently with repository
writes whose complete payloads already belong to the page. Keeping the guest
realm alive would not make those writes safer and would retain unnecessary
resources. The page still awaits and records the sink result, appending failures
without replacing its original exit reason or redrawing a restarted session.
A slow sink remains pending after a waiter times out or a terminal disappears;
no accepted write is rolled back or retried by this boundary.

Completed receipts are aggregated immediately even when an earlier one is slow.
The consumer keeps fixed result counters, at most one representative failure
reference, and callbacks for unresolved receipts, not a history of payload copies or all completed results. Actual
pending write batches retain their existing views/journals; that resource bound
is not eliminated. Rejected later receipts are handled immediately even when an
earlier sink is blocked. One terminal-model acceptance call is not a visual
completion event, and omitted policy paths stay explicit rather than becoming
claimed saved data.

Focused tests include actual muk execution and ordered changes/output/boundary/exit
through the private Worker handler, plus delayed/rejected sink and late-message
counterexamples. The message host remains a test double, not an executed browser
UI. No positive browser host-stop proof or prepared-tree disposal is added, and
there is still no all-stage draining-close success API.

### Captured host-stop evidence before any tree-disposal decision

WorkerStop now separates request settlement from matching exit evidence. A rejected
request yields an unconfirmed result promptly, preserving its failure; a later
query may observe a matching late exit without erasing that failure. Fulfillment
of a synthetic adapter request without a matching exit remains unconfirmed.
Waiting for a genuinely pending request can remain pending indefinitely; a caller's
timeout is not evidence and does not remove the observer. Concurrent queries
share one pending race per Hand; repeated queries after request settlement add no
new callback to an indefinitely unobserved exit.

RemoteKernel.snapshotWorkerStops requires close to have been requested and reports
only the adopted-Hand snapshot captured by that call. It includes detached Hands,
records positive Node exit evidence, and leaves browser/legacy or never-stopped
warm/transferred Hands unconfirmed. Known production stop/notification diagnostics
remain in the kernel independently of removal of a positively stopped Hand. It is
not a permanent admission fence: public raw callers can create new owners later.
No result of this method alone permits scope disposal.

The private Worker still needs a closed execution-owner protocol that survives
completed rehearsal kernels without using WeakRef disappearance as evidence.
Current weak observations intentionally cannot certify that missing executions,
old Images, loader/read operations or transferred warm instances released their
ownership. Output-prefix completion is orthogonal: page-owned bytes may safely
finish storing after host retirement, but that does not certify guest-tree release.
Consequently no automatic preparedOwner.dispose is added in this step. Unknown
owners remain isolated under the finite scope/realm boundary rather than being
converted into successful completion by an empty snapshot.

### First disposal case: unpublished late preparation only

A prepared tree that completes after admission freeze can be disposed before
publication: at that exact checkpoint no Readied result has resolved, no rehearsal
or foreground kernel has received its Vfs, and no Image/Mirror/translation observer
has acquired it. Other commands awaiting readied receive the rejection, not the
tree. The preparing operation itself performs the rollback synchronously; this is
not a claim that weak observations proved all historical owners gone.

After successful disposal the single preparedOwner reference and its observation
are removed. If disposal throws, the original cancellation and cleanup error are
preserved together, the owner remains quarantined, and repeated retirement does
not retry possibly partial disposal. The raw public PreparedTree API and every
previously published/borrowed tree keep their previous finite lifetime. A rehearsal
ending or a stopped-Worker snapshot still does not authorize their disposal.

The focused late-result test uses the real file-core and a lazy pack inode, with
no payload read required. Existing Rust and legacy tests still verify that a tree
survives the end of a rehearsal borrower. This establishes only the unpublished
rollback case, not general managed tree collection or an RSS-reclamation bound.

The two host-only tests now pass their test cancellation signal to events.once.
A test deadline therefore rejects that wait and reaches its finally termination
request rather than leaving a message/exit waiter indefinitely pending. The
10-second deadline is unchanged. Abort of the waiter itself is not stop evidence;
the cleanup still awaits Node termination separately.

### Used-tree owner audit and diagnostic-independent retirement

The private root still has no general used-tree disposal barrier. `readied` and
`preparedOwner` own the published tree; preparation/rehearsal/start/serve may be
in flight; Kernel Images and deferred sources may retain Files after a process
ends; translation observers and Mirror have their own references. Closing the
last two does not clear the first ones. A rehearsal operation's finally is not
proof that every internal Kernel reference was retired.

Separate this JS ownership from CPU host ownership. `passOn` clears Hand.kernel;
Hand.kept stores numeric memory/image IDs, not JS Image/File references. CPU kept
Threads retain Wasm memory/instance/modules and the last Run, but the posted Run
does not contain Vfs/File/JS Image. This is evidence of guest-memory retention,
not evidence by itself of a reverse edge to the old FileScope. A future barrier
must prove both relevant boundaries rather than requiring CPU stop as a substitute
for tracing File references, or using a weak Kernel disappearing as proof.

One concrete obstruction is now removed: CPU/host failure diagnostics may throw,
but this no longer skips independent task retirement or scheduler wake. Assignment
identity is captured before the diagnostic and rechecked afterward, including
process identity; replacement tasks/Hands are not stopped by an old callback.
A changed live assignment leaves an explicit unconfirmed-retirement diagnostic.
Secondary exceptions and the original failure remain in the old owner's history;
all applicable phases are attempted before the same single exception, or an
AggregateError for multiple exceptions, is rethrown. Host failure remains terminal
and repeated notifications do not retry partial cleanup. A CPU error message does
not newly mark the Hand terminal. None of these observations authorizes tree
release: failed task cleanup can still leave owners quarantined.

Focused injected-Hand tests exercise diagnostic failure, independent stop failure,
wake, and replacement assignment. These test production Kernel/task retirement,
not positive real-host stop, browser UI, full Wasm guest execution, or complete
scope collection. Used-tree disposal remains a separate unfinished gate.

### Mirror publication cannot outlive synchronous retirement

Mirror construction and changes capture can walk mappings or call lazy loaders.
The private Worker now rechecks admission after construction, before installing
the Mirror or starting the kernel. It also captures the current Mirror identity
and rechecks admission/identity after changes(), before sending a changes batch.
Thus a synchronous callback that retires the root cannot install a new observer
or publish bytes by relying on the admission check made before capture. The local
capture result simply expires when that stack returns; there is no acknowledgement
of saving those bytes and no rollback claim for capture side effects.

Two real-muk Worker-handler regressions inject retirement at these Mirror method
boundaries. Construction retirement prevents a threads publication; capture
retirement prevents a later changes publication. Both leave the published tree
quarantined. They are not a proof that all possible callback paths are quiescent,
nor that ordinary scope disposal can yet run after retirement.

### Registered-operation drain precedes private root removal

WorkerLifetime now counts enter/release operations separately from its non-owning
observations. After admission freeze, settledOperations returns one shared promise
that resolves when those operations have all released; each token releases once.
Preparation, rehearsal, start commands and serve are included through their
existing finally/completion paths. An operation that catches failure and releases
still counts as settled, not successful. Newly observed unknown owners remain in
the observation table and do not become proven released merely because active
operation count reached zero.

Private retirement requests halt/close first, then starts this drain without
waiting before its existing admission acknowledgement. Waiting for serve before
requesting halt would deadlock. After drain, only the private readied promise root
is cleared; preparedOwner and the Kernel/Image/source roots are deliberately not
disposed or rewritten. Duplicate retirement does not add another waiter. A
pending operation may keep the drain pending indefinitely, and the outer browser
termination timer is not converted into a successful drain. Late keeper nudges
also check admission before touching the kernel scheduler.

This is a finite step toward a used-root barrier, not that barrier itself. Timer
callbacks, host callbacks and externally supplied callbacks are not all registered
operations. Awaiting this promise crosses the current synchronous stack but does
not certify that no future unregistered callback exists. Kernel.images/due,
process images, deferred source closures and Vfs keeper registration need their
own safe retirement rule, preserving raw public aliases outside this private
entry. CPU stop evidence stays separate. No Kernel graph history is strongly
retained to manufacture such proof.

Costs: one integer and at most one pending promise per Worker lifecycle, plus one
idempotence bit in each operation token. Existing observation records still cost
O(active or unresolved observations); no claim of fully bounded root collection or
lower RSS follows. Tests separately cover pending operations, duplicate release,
late unknown observations and failed-but-settled work.

### Retire outstanding translation-cache delivery, not its host I/O

The concrete unregistered callback path is keeper: a Cache Storage read completes
later, stores a Taken translation, reports used URLs and wakes a kernel. It owns
no File directly, but a supplied callback can capture a Kernel, and late delivery
must not revive a retired private root. keeper now returns RetirableReading, an
additive capability over the unchanged Reading interface. close is idempotent,
rejects new consumption (has false, take null), clears undelivered cached results,
and disconnects ready/read callbacks. It does not cancel an issued host read;
reading reports the actual pending count until settlement, even after close.
Late results are discarded. A Taken value already returned remains caller-owned.

Read notification and wake exceptions are now recorded separately in failures;
they do not turn a successful capture into a load failure, skip the independent
wake, or leave a detached finally promise rejected. Reentrant close from read
suppresses the subsequent wake. Private Worker closes its keeper immediately
following admission freeze, before requests/drain. The raw standalone caller need
not close: existing take-once/reload behavior remains.

Tests use a controlled host cache returning a digest-verified real Wasm module,
including delayed completion, reentrant close, both notification failures and
normal repeat reads. This is not real-browser Cache Storage validation. A first
test incorrectly assumed one microtask meant match had started; it failed and was
corrected to await explicit match entry, not by loosening the ownership assertion.
No read abort, collected RSS, FileScope disposal or Kernel/Image.source revocation
is inferred. In particular a previously returned Taken and raw public Image alias
cannot be invalidated by closing this delivery owner. Image/source retirement is
still a distinct gate after private operation/callback ownership is closed.
Notification functions here have a synchronous contract; returned asynchronous
promises are not observed. Disconnecting callback slots is not a measurement or
guarantee of physical GC of all lexical environments.

### Release one proven inactive private foreground reference

Do not null Image.source to simulate owner release: old aliases can still depend
on deferred translation. Besides images/due, inline spare memories can retain
pooled Images, instances and slots leading back to Tasks/Kernel. Translator close
also has its own opened/known ownership and failure semantics; shared rehearsal
translator resources cannot be blindly closed through free(0). This step leaves
those objects and their behavior unchanged.

Instead the private foreground field can be dropped only after registered operation
drain, with no retirement or recorded lifecycle failure, null current task, empty
tasks/procs/runq/blocked, and absent Vfs keeper registration. For RemoteKernel,
the captured stop snapshot must additionally have no unknown Workers or failures.
After that await, field and token identity, failures and inactive state are
rechecked. Pending stop or thrown/failed/unknown evidence retains the reference;
exceptions are recorded, not abandoned as an unhandled promise. The separate
foreground-reference observation tracks this field only. The historical
foreground-kernel observation and prepared-tree owner remain: releasing a field
is not claiming every Image/source owner released, nor authorizing tree disposal.

Late paused callbacks now return without looking up the global kernel or calling
held after freeze. Pump does not reschedule a timer after retirement. These
boundaries allow the field to become null without making a late idle callback
read a removed global root. Keeper delivery is already explicitly closed.

Real-muk tests cover successful inline and actual Node-host paths, injected halt
failure, and an injected unconfirmed Node snapshot. The latter tests the rejection
condition, not real browser termination. Mirror reentry tests also count held
calls after freeze. Captured Image.source function identities and file readability
remain intact after field release. None of this measures GC/RSS or claims source
alias enumeration, historical rehearsal disposal or full root collection.

### Used-root ownership: explicit raw owner versus managed private admission

The raw public API is not intrinsically unsafe: prepareTree's caller explicitly
owns when its Vfs/File/Kernel/Image aliases stop being used, as dispose documents.
It does not supply machine-verifiable release receipts for arbitrary external
aliases. Existing raw callers cannot silently be promoted to automatic collection
by counting only the library's internal references. Adding managed collection must
keep that raw ownership contract distinct, not revoke Image.source behind users.

The private Worker has a narrower input/output contract: messages transfer program
bytes/modules, inputs and captured outputs, not live host File/Vfs/JS Image graphs.
It can therefore eventually establish a closed admission boundary, but current
records still have the following different meanings:

| Holder | What is already closed | What is not yet disposal evidence |
| --- | --- | --- |
| readied | own promise reference removed after registered operations drain | preparedOwner still owns tree |
| foreground field | conditional inactive/reference release with Node evidence | other JS aliases and historical kernels |
| rehearsal operation | finally settles registered operation/timer | no success receipt for all File/source aliases |
| observer/Mirror | no new publication after close/freeze | already captured local references until stack returns |
| keeper | late read delivery detached, outstanding read count preserved | host read completion/cancellation or caller-returned Taken |
| warm/detached CPU | matching Node stop evidence only where available | CPU memory retention does not prove host File retention |
| public raw aliases | explicit caller lifetime responsibility | no automatic library-wide last-owner knowledge |

For historical rehearsal the next receipt must separately record execution
settled, failure/unknown versus normal completion, timer/callback closure and any
host ownership still outstanding. It must not retain every old Kernel graph to
make bookkeeping easier. Conversely WeakRef disappearance cannot synthesize a
success receipt. Rehearsal is optional for startup speed, but its failure is not
optional ownership evidence: rejection is now latched in lifetime.failures even
though startup continues. A rehearsal timer halt exception is also caught and
latched. That exception does not release the operation; it may remain pending
until a separate private freeze lets the loop unwind, or indefinitely for an
unsettled host run. No time limit turns it into successful retirement.

Two real-muk handler regressions cover optional rehearsal failure followed by a
successful foreground run (failure still blocks reference release), and a real
initialized inline kernel whose pump/stop are injected to exercise the production
timer failure callback (deadline accelerated in the test). The latter keeps the
operation pending until explicit retirement and does not claim the guest executed
to completion. Both preserve the tree and historical unknown observation.

### Initial namespace back-edges are not removed by ended()

Source audit and regression tests establish two concrete reverse edges after a
rehearsal: Vfs.who.root points into its initial mount tree, and shared Entry.covered
arrays hold its mounted procfs/sysfs/cgroup nodes. Their callbacks retain the old
Kernel and thus Images/sources. ended() only unregisters the loaded-file keeper;
replacing the walker during a later foreground construction does not remove the
covered edges. A success receipt cannot omit this namespace ownership.

An explicit Kernel.retireInitialMounts action now permits an embedding owner to
retire only that initial tree's structural edges. It is never automatic on raw
Kernel/process exit. The caller must already prevent future execution and confirm
host stop as required; public raw aliases remain its responsibility. It rejects
nonempty execution state/keeper registration. The mount helper preflights the
entire initial tree: zero refs, matching namespace identity, no propagation group
or master or locked mount, consistent parent/children, no repeated node/cycle, and
exactly one matching covered entry. Any rejection leaves all edges unchanged.

After complete preflight, synchronous leaf-first detach removes only each target
identity, preserving other namespaces' covered order and graph. If the shared
walker still names this Kernel's root, it is restored only to the original
unattached Vfs base; another Kernel's walker is untouched. This is not lazy umount:
that intentionally retains descendants and can propagate to peers. No callback
or File payload work occurs during structural mutation. Cost is O(mounts plus
covered-array searches/removals), not a scan of every file or payload byte.

The private Worker starts a bounded, nonblocking check after normal rehearsal and
timer cleanup. At most one rehearsal belongs to its prepared result. For Remote,
missing stop evidence (including pass-on warm Workers) leaves mounts intact and
records unconfirmed host ownership. Successful structural retirement records only
initial-mounts-retired; it does NOT release the historical rehearsal-kernel
observation or call preparedOwner.dispose. A pending check remains an explicit
unknown observation, separate from registered-operation drain; there is no
startup wait for it. Its continuation retains the current Kernel only until the
check settles, not an unbounded history of completed kernels.

Guest-created namespace/bind copies can still retain the same procfs Super and
callbacks. Tests specifically preserve such a copy, plus another Kernel's shared
entry order/walker, and reject busy, shared, missing, duplicate and foreign edges
without partial mutation. Actual inline rehearsal followed by foreground startup
exercises the narrow successful path; actual Node pass-on rehearsal stays
unconfirmed. This closes the initial structural back-edge only, not all namespace
copies, raw aliases, Image/source ownership, or general used-tree collection.
The preflight/mutation guarantee assumes the runtime's ordinary Mount/Entry/Set
objects, not a raw caller replacing them with reentrant getters or custom
collections. Additional lightweight regressions reject locked/master propagation,
a cycle and duplicate-child attachment without changing any edge.

### Namespace files are ownership crossings, not target-mount refs

fileOf('mnt', ns) returns a node on the common nsfs mount. Description increments
that mount's refs, not any mount in ns.top. Its File-to-namespace association can
also survive through a raw Place, bind mount or an fd carried by SCM_RIGHTS. A
zero-ref target tree is therefore not a proof that its namespace is unobservable.
The normal structural retirement path now refuses an initial namespace once a
namespace File has been issued. A WeakSet records issuance before every return,
including a reused File; it adds no strong namespace root and is not cleared by
FD close. This is conservative history, not proof that a value actually escaped:
a failed open or an unused returned Place may still force retention. Tests cover
issuance, descriptor-held and descriptor-closed states separately, while showing
that the represented tree's refs stay zero throughout.

This does not solve cloned namespace ownership. copySpace can reuse procfs Super
callbacks, setns imports a namespace through a File, mount propagation can create
cross-namespace edges, and arbitrary public Image aliases can retain source
closures independently. Three alternatives remain distinct:

* Per-reference ownership on every namespace File/descriptor/mount crossing would
  require complete acquisition/release coverage, including SCM_RIGHTS queues,
  bind mounts and cycles. Adding only descriptor counts is not enough.
* A genuinely private root ownership boundary could track namespaces created or
  imported by its kernels and prohibit untracked live-object export. At closure,
  internal cycles could be retired together after processes/callbacks/hosts end.
  That requires provenance at clone/unshare/setns and propagation boundaries,
  not simply relabeling the existing public graph as managed. sods must own the
  runtime meaning; no reverse dependency on ricebox/why should be introduced.
* Existing finite realm ownership retains unknown aliases and ends the whole realm.
  It remains the safe fallback, not evidence of prompt reclamation or a viable
  unbounded long-lived cache. Browser request-return is still not stop evidence.

For the second alternative the necessary record scales with namespace creations
and ownership crossings, and teardown with mount edges, not file payload bytes.
It cannot infer absent raw aliases for free. Image.source should still not be
revoked behind callers; the boundary must first establish who can invoke it.
No generic domain manager, automatic copied-namespace destruction, or used-tree
disposal is introduced here. The sticky initial-namespace gate closes the proven
hole without pretending the larger ownership contract has been implemented.

### Minimal managed API decision and the next creation boundary

Do not add a user-facing domain manager or a managed:true flag to the raw Kernel
API. Returning Kernel/Vfs/Image still permits arbitrary aliases, so that flag
would not establish closed ownership. The existing private Worker/run command
entry is the appropriate place for future managed ownership: applications supply
artifacts/declarations/inputs and receive captured values, not a namespace graph.
The normal ricebox setup/deploy flow and standalone muk/sods entry points need no
new ownership-management ceremony. Raw linux/prepareTree remain explicitly owned
by their embedding caller. This is a design choice, not an implemented sealed
runtime domain or final safe-close result.

The required internal crossings are concrete: clone/unshare copy namespaces;
setns adopts an existing namespace File; bind/open_tree and propagation can share
Supers; SCM_RIGHTS holds Description objects in queues, not just fd tables.
Image creation/prebuilt/consolidation, memory pools, readLater and observer tracks
are a separate alias family. A private owner must record creation before
publication, distinguish internal transfer from unknown imports/exports, and keep
failure/unknown state. Completion must distinguish execution, host stop, output
persistence and tree retirement; the existing retiring message remains admission
acknowledgement only. No source callback is revoked to force these facts true.

A real syscall counterexample identified an earlier necessary boundary: with
cgroup capacity zero, clone(CLONE_VM|CLONE_NEWNS|SIGCHLD) returned EAGAIN with
process/task counts unchanged but /proc.covered grew from 1 to 2. spaces() copied
and registered the namespace before room() refused it; loss of the local variable
was not rollback. The implementation now separates credential/capability checking
from mount/other namespace construction. Clone retains permission checks first,
then the existing PID-ended/cgroup checks, then constructs the requested spaces.
Thus these known refusals do not allocate/register the abandoned mount tree.

NEWUSER credential checking still constructs a UserNs, so this is not a claim of
zero allocation before refusal or a pure validator. NEWPID keeps its prior fresh
children semantics; unshare still validates and constructs through the ordinary
path. Fork/newThread/Fs preparation can fail after this point and still require
an explicit publication/rollback protocol. This fix is not that full transaction.
The avoided work on rejected clone is the mount copy and its covered/propagation
registrations, proportional to copied mounts; no extra payload copies or graph
manager are introduced. Regressions preserve errno precedence and verify no new
mount edges in both process and thread clone refusal paths.

### Fork preparation: preserve the live memory before retiring child owners

The next transaction cannot be implemented as `catch { exitProcess(child) }`:
process exit publishes wait/signal/PID-namespace effects, whereas a failed fork
has not published a child. Current acquisition order is:

1. clone permission and PID/cgroup refusal, then namespace copy (covered and
   propagation registrations already visible);
2. fork shared-mapping synchronization (successful writeback is not undoable);
3. Process FD share/copy, Fs owner, and cgroup membership;
4. Task PID numbering and transfer of Fs ownership, then provisional PID init;
5. Image alias, memory ownership, x87/instance preparation, mapping owners;
6. parent children, process/task maps, and run queue publication.

A failure at 2 must not blindly retire all copied namespaces after a later
failure at 5: the latter may already have a live Fs/task/backend alias. Proper
unpublished-owner cleanup remains unfinished, as does thread creation cleanup.
The minimal next ordering seam is internal synchronization before namespace
construction, retaining direct forkProcess behavior and exactly one sync; do not
add a public `alreadySynced` boolean or duplicate the mapping scan. Callback
identity changes and partial successful writeback require explicit treatment.

Before attempting that owner transaction, an actual Wasm counterexample exposed
parent corruption at step 5: active data initialization writes imported memory
before a trapping start function fails. Task.load's existing snapshot was only
restored after successful instantiation. Restore it in finally, into the supplied
memory's current buffer, without revoking Image.source or other Image aliases.
The existing snapshot/copy range and normal-path byte work are unchanged. This
is not arbitrary start-function rollback, concurrent SAB writer protection, or
release of partially acquired child owners. Writes outside the declared image
range and other start side effects remain outside this narrow guarantee.

Validation: the real Wasm control demonstrates the overwritten byte after failed
instantiation. Before the change, the runtime failure test returned 1 instead of
99; afterwards success, start trap, and grow-then-trap preserve the parent bytes.
The grow case verifies that restoration reacquires the current buffer; reentrant
host callbacks are not tested here. Tests stub x87 allocation and run no translated
FPU code. No namespace/Image lifetime or whole-fork completion is inferred.

### Remote child preparation owns a lock before it owns a published Thread

The actual CPU Worker had the same snapshot-on-success-only defect, and a second
owner leak: Thread construction acquires the process GIL before `start()` returns
and publishes into `task`/`kept`. A constructor trap escaped to the message error
handler, which has no reference to that unpublished Thread. An actual Node CPU
Worker test observed parent byte 1 (expected 99) and GIL owner 21 (expected 0).

The constructor now catches preparation failure across take/lock/instantiate/
attach/begin. It restores the existing keep range on instantiate failure only
while the captured GIL still names this tid. Cleanup uses compareExchange on the
captured GIL/tid, never an unconditional unlock of a different owner. Its x87
handle is cleared before release through the captured allocator. Original and
cleanup failures are preserved together, including in the message text (the
Worker's existing stack serialization does not serialize AggregateError.errors).
No channel LEFT/host-stop success is invented. Failure reporting still goes
through the existing host path. If ownership was lost, restoration is refused;
this is not a successful memory recovery. Again/reused Thread failure and raw
start-function side effects remain separate gates.

Focused verification: 6 tests pass, including real Node CPU start-trap recovery
and a second failed construction with a different tid using the same lock. A
separate actual Node Worker test injects lock replacement at the Instance
boundary and verifies that owner 99 remains untouched and the original failure
and cleanup uncertainty reach the error message. That is boundary fault
injection, not an actual guest scheduler race. Historical translator supplies
x87; the test module is real small Wasm, not current-source translation.

Remaining transaction obligations (not discharged by this constructor change):

- namespace: record exact newly created mount/propagation edges, distinguish
  external/adopted spaces; no teardown while a surviving Fs/namespace alias can
  reach them. Avoid new copies before sync failure in the first place.
- FD/Fs: undo only the new owner share/copy; close failures need independent
  cleanup and original-error preservation. Constructor failure before return
  currently has no returned owner token. Parent tables and locations survive.
- PID: number reservations and provisional namespace init need distinct commit
  points; do not mark a namespace ended or notify a parent for an unpublished
  child. A number consumed need not be reused to undo a registration.
- memory: a shared owner decrement differs from retiring the live parent's
  generation. Never reuse a private memory without proving all backend readers
  stopped; failed preparation is not by itself that evidence.
- publication: child.tasks, parent.children, procs/tasks and scheduling are
  separate writes. `go` may invoke backend work, so a catch around the whole fork
  is not proof that the child stayed unpublished. Ordinary exit is not rollback.

No new public manager or raw ownership inference was introduced. Normal CPU
initialization retains the same snapshot/copy byte count, with bounded lock
checks and failure-only diagnostics. Full managed tree disposal is still gated
on these remaining ownership proofs, not this local recovery test.
Independent source review found no blocking issue for this constructor scope.
Tid equality follows the existing cooperative lock protocol; it is not an epoch
or proof that the lock was never released/reacquired. Actual inline and Node
rehearsal regressions also pass (2), as does focused strict TypeScript checking.

### Process Fs-acquisition refusal returns its already acquired FD owner

The Process constructor acquires a copied/shared FD table before acquiring Fs.
A failing Fs.copy left either Description.refs or table.holders incremented,
although no Process was returned. The constructor now captures the acquired
table and returns exactly that owner if Fs acquisition throws. It does not read
parent.fds again during rollback, invoke process exit, change a PID namespace,
or undo the callback's own changes. Successful cleanup rethrows the original
error identity (including FsError/errno); failed cleanup preserves both errors
and does not retry. The copied table's existing independent slot cleanup allows
other acquired descriptors to retire after one release callback fails.

Five added boundary-injection regressions pass: shared/copied Fs refusal through
the actual clone syscall; copied-descriptor cleanup failure preserving both
errors and cleaning the other descriptor; shared/copied cleanup after callback
replacement of parent.fds. Parent descriptors remain open, original refs/holders
return, and no new cgroup/task/process/PID publication is reached. Initial three
regressions failed before this fix. These are boundary faults, not simulated
allocator exhaustion or proof that Fs.copy partial allocation is transactional.
FdTable.fork's own partial failure, Fs partial acquisition, later constructor
failure and all previously listed namespace/memory/publication gates remain.
Normal-path FD copy remains O(number of descriptors), sharing O(1); the change
adds no scan, copy, owner registry or public API on successful preparation.
Focused family regression: 13 pass; actual inline/Node rehearsal: 2 pass;
focused strict TypeScript and independent source review pass.

### FD-copy construction has an unpublished acquisition ledger

FdTable.fork itself now returns the completed retain prefix when construction
fails. A single pending Description records the interval after retain returns
but before the copied slot is installed; each installed slot owns its own retain,
including duplicate descriptors. Failure independently releases pending and the
unpublished copied table; cleanup errors accompany the original failure, while
successful cleanup rethrows the same original error/errno. Console metadata copy
is inside the same boundary. The parent table is never closed or replaced.

Six focused tests cover refused retain, duplicate slots, failing cleanup with
continued retirement, failure after retain but before slot registration (metadata
getter), failing pending release, successful copy/release, and detached console
metadata causing a real TypedArray.set failure. Initial three counterexamples
failed before this patch. Injected retain/release/getter faults are boundary
injections, not claims of allocator-exhaustion recovery. A custom retain that
mutates then throws without returning, or a custom Map that inserts then throws,
provides no completed-transfer evidence and remains outside the guarantee.

Normal copying stays O(descriptors) with the same retained references and console
copy, one O(1) pending local, no second scan/registry. Error cleanup visits the
acquired prefix only. This closes FD-copy partial ownership, not Fs's own partial
acquisition or subsequent Process/Task/PID/memory/namespace publication. The next
higher-value gate remains placing one shared-mapping synchronization before new
namespace construction without changing public fork semantics or duplicating the
scan, then proving ownership cleanup across actual Task/backend preparation.
Focused FD tests: 6 pass; family: 13 pass; actual inline/Node rehearsal: 2 pass.
Focused strict TypeScript and independent source review pass.

### Sync-before-namespace: demonstrated failure and the remaining contract choice

An actual File.settle mapping trace now demonstrates the ordering defect without
replacing Process.syncShared: two one-byte dirty mappings, first ordinary File,
second File subclass refusing publishRange with EIO; NEWNS|VM clone returns -5.
The first file's accepted byte is 2, procs/tasks stay 1, but /proc.covered grows
1 -> 2. The second mapping's refusal is injected at its storage publication
boundary. Already accepted first-file publication must remain accepted; a fork
rollback must not restore an old file snapshot. The probe is a diagnostic, not
a passing regression or a new guarantee.

The least invasive ordering must keep permission/PID/cgroup refusal before the
single all-mappings sync, then construct new namespaces only after sync succeeds.
Moving a call out while leaving forkProcess's call would add a redundant scan.
Calling an internal child-construction helper directly from clone would bypass
raw subclasses overriding forkProcess and weaken the Proc interface with a cast;
independent review rejected that alternative.

Preferred candidate: a narrowly typed deferred namespace preparation in the
existing forkProcess options, used by clone and invoked by base forkProcess once
after successful sync and identity revalidation. Existing raw calls without it
keep their behavior; overrides forwarding options to super keep the seam.
Overrides discarding options or doing their own child creation do not establish
that guarantee. This is an extension to the raw method contract, even without
new public linux exports or a user-facing manager. Do not hide that fact behind
a symbol/WeakMap or claim zero API impact. A repeated preparation request must
fail rather than constructing a second namespace. The clone remap step must use
the exact namespace copy that was prepared, not reconstruct it after return.

Remaining proof before adopting the candidate: sync may reenter an embedding.
Memory generation/image/task replacement must refuse child creation; preserve
both original sync failure and changed-identity evidence if both occurred.
Other input ownership (Fs/FD/credentials/namespaces/cgroup) and capacity changing
during the callback need an explicit policy, not a claim that a memory check
alone makes fork atomic. Repeating room/permission checks can change error order
and add normal work, while taking a broad state snapshot invents a new contract.
The next implementation should choose that policy explicitly before adding a
callback option. Current code has not adopted the option or fixed the demonstrated
namespace leak. Independent review reached the same compatibility boundary.

### Adopted bounded sync-before-namespace contract

The deferred seam is now implemented as ForkOptions.prepareNamespaces, retaining
clone's call through p.forkProcess. Base forkProcess performs one all-mappings
sync and then validates captured memory generation/buffer/state, task, Image,
FD table, Fs and root/pwd/umask, credentials, Spaces and cgroup identity. Changed
owners produce ForkPreparationChangedError, not guest errno or automatic kill/
reclamation. If sync also failed, both failures survive in AggregateError; when
ownership is unchanged, the exact sync error (including FsError) survives.

Clone's internal preparation consumes its one-shot before work, rechecks ended
PID namespace and cgroup room in that order, then creates namespaces. Entry-time
permission/PID/capacity refusals still precede sync. Successful earlier file
publication remains accepted. Rechecking room costs another hierarchy/capacity
check because sync can reenter and consume capacity; it does not add another
mapping scan. New namespace construction and child ownership acquisition do not
occur on the demonstrated publication refusal.

Policy boundaries: credential values follow existing immutable `with` updates;
raw mutation inside objects, restoration ABA, arbitrary preparation callbacks,
and overrides discarding options are not transactionally protected. Delegating
overrides forwarding options to super retain the seam, as regression-tested.
Raw callers without preparation retain their options; raw fork now explicitly
refuses input-owner replacement during sync. This is a documented raw contract
extension, not zero API impact. No new public manager or general rollback engine.
The dispatcher still has its pre/post syncShared(false) behavior; the test's
exactly-one assertion counts fork's syncShared(true), not all dispatcher calls.

Validation: family 38 pass, including actual File.settle accepted-prefix +
publication EIO with /proc.covered now 1 -> 1 (previously 1 -> 2); 20 injected
identity-change/throw cases; changed capacity/ended namespace error priority;
forwarding override; refusal-consuming one-shot. Actual inline/Node rehearsal
2 pass and focused strict TypeScript pass. Host callback fault tests are not
concurrent guest race proofs. Fs partial allocation and namespace/Task/PID/
memory ownership after preparation and partial publication remain unresolved.
Independent review caught a pre-super override gap: checking only inside base
forkProcess could combine earlier credentials with an override-modified parent.
The bounded guard now also captures clone's checked context before calling the
override and verifies it at one-shot entry. Three before-super credential/Spaces/
Fs replacement regressions pass; family total is now 41. The shared helper is
internal to sods, with no new linux entry export. Two bounded owner captures are
intentional to cover the raw method boundary as well as sync reentry.
A final counterexample covered replacement before super followed by an early
sync FsError (before the namespace callback). Clone now checks its original
context on failure too. The shared failure helper preserves both errors without
duplicating an already reported ownership error. Family total: 42 pass, strict
TypeScript pass. Override side effects after successful child publication are
not rolled back by this boundary and remain outside its guarantee.

### RemoteTask channel failure returns only its completed Fs acquisition

Task construction has two different Fs transfers: a sibling retains the existing
thread's Fs (users++), while a first task takes Process.fs0 without incrementing
users and sets Process.taken. RemoteTask then allocates/takes its channel and
constructs views before any Worker assignment. Failure there previously left the
extra user, or left taken=true with no returned first Task.

The constructor now captures the transfer context before super and guards the
channel/view initialization. On failure with unchanged context it drops only the
sibling's added Fs owner, or returns first-task ownership to Process by restoring
taken without dropping Fs. A changed fs0/taken/own task or mismatched Fs is not
reconciled by guessing: original failure and unknown-ownership cleanup failure
are both retained. Normal process/thread exit, signals, PID namespace retirement
and memory recycling are not invoked. Successful acquisition adds bounded local
captures/check setup only, no file/namespace scan or payload copy.

Workers regression: 28 pass, including eight new boundary cases (both Fs paths
with channel refusal and real invalid-view RangeError; cleanup callback failure;
fs0/taken/new-task reentry). Initial three cases failed before the change. These
are controlled channel boundary failures, not an actual host memory exhaustion
claim. Arbitrary in-place/ABA mutation remains unproved. PID reservation cleanup,
super's own partial failure and reuse of a channel already removed from the pool
are separate gates; no blanket fork rollback or managed tree disposal is claimed.
Actual Wasm/CPU Worker focused tests: 6 pass; actual inline/Node rehearsal: 2
pass; focused strict TypeScript and independent source review pass.

### Prefer preparing the channel before acquiring PID/Fs owners

The prior RemoteTask cleanup boundary still consumed PID numbers before a
channel failure. Strengthened tests showed nextPid/namespace.last advancing
although Fs was restored. Rather than add PID rollback (which must not reuse
observable identities or erase another reservation), RemoteTask now prepares its
channel and both typed views before numbered/Task super. These operations need
no Task/Fs/PID. The private constructor receives the same fixed RemoteKernel
used by newTask; no cross-callback relookup of the backend is introduced.

This supersedes the preceding post-super channel cleanup: it is removed, not
stacked with another rollback layer. A failing channel callback now has no new
Fs/PID owner to retire, so its exact original exception survives even if it
changed the parent. Those callback-owned changes are not undone. Successful
channel initialization and CH.FILTERED reset remain intact. Normal view count,
PID assignment and Fs acquisitions are unchanged; failure creates fewer owners,
with no new normal-path scan/copy/registry.

Workers 30 pass. Four strengthened failure cases first demonstrated the consumed
PID, then passed with unchanged counters. A fresh nested PID namespace retains
its first number after channel failure and uses 1 on success. Another test uses
an actually reusable CH.LEFT channel and verifies removal from the pool and
cleared header/filter state. These are backend boundary tests, not full fork
rollback or failure inside numbered/Task super. A channel already taken from a
pool is not blindly put back on later failure: safe pool return and Task super/
numbered partial acquisition remain separate gates.
Actual inline/Node rehearsal: 2 pass; focused strict TypeScript and independent
source review pass. No external publishing or browser/desktop execution.

### Return the unassigned channel independently of later Task ownership

With channel acquisition first, a later numbered/Task-super failure has one
already proven unassigned resource: the channel. The private constructor now
catches only that super/numbered expression and returns this captured channel
once via the existing Kernel.release pool operation. Successful return preserves
the original exception; failed return reports both and is not retried. This
neither invokes endTask/exitProcess nor pretends PID/Fs acquisition rolled back.
Invalid view creation remains outside this catch, so such a buffer is not put
into the pool. Full size/unassigned provenance relies on kernel.channel's
existing contract, not merely on view construction succeeding; arbitrary raw
channel implementations violating that contract are unsupported here.

Workers 34 pass. Four new cases cover refusal before/after numbering, failed
release, and Task-super metadata refusal with successful channel reuse next time.
The super case explicitly observes that PID numbering still advanced: that gate
is not hidden by successful channel return. Initial three counterexamples failed
before this change. Failures are injected at the actual backend preparation
boundary, not host allocation-exhaustion or full-guest rollback proofs. Normal
path creates no new payload copies or scans and keeps the same channel/view work.
Actual inline/Node rehearsal: 2 pass; focused strict TypeScript and independent
source review pass.

### Task metadata preparation precedes numbering and Fs transfer

A further acquisition-order improvement removes PID/Fs work from ordinary Task
metadata failure. Default Kernel.newTask now constructs Task without a supplied
number; Task initializes metadata and its Pending/altstack/cpu objects first,
then assigns a PID and performs its final Fs ownership transfer. Explicit tid
calls retain the old raw behavior and never invoke numbered. RemoteTask's
already-prepared channel is still returned if super fails. Both backend entries
refuse a Process belonging to another Kernel before acquiring anything, so lazy
numbering cannot silently change which Kernel numbers it.

Four initial counterexamples demonstrated metadata refusal consuming PID records
and late field refusal leaking Fs users/taken. After reordering, Task-focused 9,
Workers 34 and family 42 tests pass (85 sequential total). Tests include first
and sibling Task paths, nested PID namespace records, numbering refusal without
Fs acquisition, exact normal owner increments, explicit tid and cross-kernel
refusal. The prior Remote super-refusal test now correctly expects no PID
consumption rather than freezing the old defect. Faults are controlled metadata
boundary injections, not proof of recovery from JS heap exhaustion.

No new scans, payload copies, callback manager or intermediate state object was
introduced. Task's internal/direct constructor now accepts omitted tid as lazy
numbering; direct explicit-number consumers are preserved. Successful default
acquisition has the same objects and reference operations, reordered. An
arbitrary numbered override that mutates the parent, partial failure inside
numbered itself, or a hostile setter throwing during the final scalar writes
is not solved by this ordering. The captured source Fs is not rediscovered after
numbering. PID reservation publication/rollback remains a separate gate; channel
return does not prove it, and no whole-fork completion is claimed.
Actual inline/Node rehearsal: 2 pass; focused strict TypeScript and independent
source review pass.

### Failed PID registration removes only its attempted lookup prefix

number(space) previously left namespace lookup entries if a later Map.set failed.
It now cleans only the completed/attempted prefix, including a set that inserted
then threw. An absent entry requires no action; a matching global ID is removed;
a different owner is left intact with uncertainty reported. get/delete failures
are caught independently so the remaining prefix can retire. Original failure
identity survives clean rollback of entries; cleanup failures accompany it.

This is lookup cleanup, not PID rollback: last counters stay monotonic to avoid
reusing possibly observed IDs. Loss of number 1 in a fresh namespace on this
exceptional path is unresolved, so successful retry is not claimed to restore
full Linux first-process semantics. Partial failure of the outer Kernel.numbers
registration is another boundary. Raw overriding methods with unobservable or
same-ID alias side effects remain outside the guarantee. Tests inject errors at
observable map operations, not a claim of recovering safely from host heap OOM.

Six PID tests pass: before/after-insertion failure, read/delete cleanup failure,
replacement/unrelated entries, unattempted ancestor preservation and monotonic
counters. Initial four tests failed before this patch. Task 9 and family 42 also
pass. Normal work retains the existing number array plus one attempted-namespace
local; no successful-path extra lookup scan, copy or allocation ledger. The
failure path alone traverses its attempted prefix.
Actual inline/Node rehearsal: 2 pass; focused strict TypeScript and independent
source review pass. Arbitrary ancestor-chain mutation is not proven safe.

### Outer Kernel registration owns the proof for inner PID lookup retirement

Kernel.numbered now captures the exact {space,nrs} record it tries to publish.
If outer registration or stale-ID pruning fails, it retires only that record
identity. Once outer removal succeeded (or absence was confirmed), it removes
matching namespace lookups through the shared failure-only helper. If the outer
record was replaced or its retirement failed, it retains inner lookups too: a
numeric ID match alone cannot distinguish a replacement owner's adopted ID.
Original and cleanup failures remain explicit. Partial successful pruning of
unrelated obsolete IDs is not reversed. Counters remain monotonic.

PID tests 12, Task 9 and family 42 pass (63 sequential total). New cases cover
outer insertion before/after throw, replacement with the same global ID, outer
and inner removal refusal, and old-ID pruning that removes one entry then fails.
The first two new counterexamples failed before this change. Normal successful
registration uses the same record and scans as before; cleanup proof and extra
lookup traversal occur only on failure. Map faults are injected, not OOM proof.

PID1 policy remains explicitly unimplemented. Reusing number 1 is not justified
by removal of map entries alone; setting ended=true is also not justified because
that currently means an executed init ended, and reentry may have established a
new owner. A separate reservation-failed state versus the existing init-exited
state needs a finite lifecycle contract, including ancestor namespaces. No
blanket namespace termination, counter rewind, or successful retry claim was
added to disguise this gap. Later Task/fork publication remains separate work.
Independent review required positive delete results, not just absence of throws.
Both outer and inner deletion now reject false as unconfirmed retirement; outer
false retains dependent inner entries. Two added cases pass (PID total 14).
Actual inline/Node rehearsal: 2 pass; focused strict TypeScript passes.
Independent source review confirmed the false-result correction with no further
blocking issue. PID1 lifecycle remains undecided and unchanged.

### Lost PID1 records refuse new reservations, not existing owners

A bounded policy is now implemented instead of resetting counters or reusing
ended. PidNs.firstReservationFailed records failure of a registration that
consumed local number 1. It is distinct from init exit and is retained even if
lookup cleanup fails. Before number() increments any counter it checks all
nested ancestors: failure recorded plus absent init refuses new reservations
with ENOMEM. Root global ID consumption is not this gate. Kernel outer
registration failure records the same fact. No existing init, ended flag, or
other owner's lookups are changed.

Clone checks this admission before namespace construction, including NEWPID
(which must not bypass an unavailable ancestor), after sync reentry, and in the
thread branch before mount copying. Established init owners are not revoked by
recording a failure. This is deliberately new-reservation admission, NOT whole
namespace fail-closed completion: an already reserved PID2 may still reach its
later publication gate, and successful numbering followed by Task/Process
failure is not classified by this registration-failure record. Those publication
and lifetime contracts remain unfinished.

Alternatives rejected: rewinding counters can reuse observed identities; using
ended conflates reservation failure with an executed init's death and can revoke
new owners. The chosen policy trades availability of an uninitialized namespace
following a failed first registration for avoiding ordinary retry creating a
silent init2. No claim of transparent retry or complete Linux compatibility is
made for that exceptional path.

PID 17 and Task 9 pass; family 45 pass. Coverage includes target and ancestor
admission, counter stability, cleanup failure still recording the loss, reentrant
established init ownership remaining intact, process/NEWPID/thread refusal before
mount copying. Existing failure tests now expect admission refusal instead of
retry number 2. Checks add O(namespace depth) scalar inspection, not mapping/file
scans or payload copies; this is necessary ancestor admission work, not zero-cost
safety. Independent source review found no blocking issue for this limited gate.
Actual inline/Node rehearsal: 2 pass; focused strict TypeScript passes.

### Fork init publication follows executable/memory preparation

forkProcess no longer assigns pidns.init immediately after newTask. It captures
the returned reservation record, finishes Image/memory/load/register preparation,
then checks publication immediately before child/task/parent/kernel insertion.
Nested publication requires the same outer record and target namespace; absent
init additionally requires local PID1 and matching namespace lookup. Ancestor
admission is checked again so an already reserved PID2 cannot evade a later
first-registration failure. Existing init owners are not overwritten. Gate
failure is a host Error, not a guest errno or ordinary process exit.

The gate is limited to fork's publication point. It does not make child.tasks,
parent.children, kernel maps and go atomic after init is assigned. It does not
retire resources from preceding preparation. An actual Wasm start-trap regression
now confirms init remains 0, while cgroup.procs still contains the unreturned
child and shared memory.users remains 2. This is explicit unfinished cleanup,
not a managed quarantine claim: the cgroup roots child/FD/memory, but a Task that
never entered child.tasks can lose its direct owner handle. Those Fs/x87/Task
retirement obligations require the next transaction boundary.

Six publication checks cover normal PID1, reserved PID2, record replacement,
lookup replacement, failed admission and preservation of established init.
Focused combined tests: 73 pass, 2 CPU tests skipped without translator env;
the full process took about 30 seconds, slower than earlier runs. No failed test
or timeout was observed, and no full-suite heavy retry was attempted. A later
narrow actual child-Wasm case passed in ~0.4s after fixing the fixture to obtain
its parent's PID through normal newTask rather than reusing an explicit number.
Focused strict TypeScript passes. The gate adds record identity reads and
O(namespace depth) checks, no payload copies or mapping scans. Successful-number
followed by other preparation failures remains distinct from registration-failure
admission and is not disguised as full fork rollback.
Review found an additional publication race: an init can end during preparation
while its init ID remains nonzero. The gate now checks ended for target and all
ancestors in the same ancestry walk as failed-first admission. New tests cover
both ended scopes and an actual fork whose setContext callback ends the namespace;
publication is refused without replacing the old init or adding child maps.
PID 25 + family 46 = 71 pass; focused strict TypeScript passes. The callback race
is injected, not an actual concurrent host scheduler demonstration.
Actual inline/Node rehearsal before this final ended check: 2 pass.
Final ended-gate revision also passes actual inline/Node rehearsal (2) and
independent source review; no additional blocking issue was reported.

### Failed new child instance: bounded preparation retirement

A trap inside `Task.load` now retires the acquired child Fs/FD/x87 and memory
ownership only when a new instance has not returned exports, identities and
memory generation still match, and no child publication is visible. Backend
retirement precedes the resource returns. Callbacks are checked again before
continuing. This is not ordinary process exit: no signals or robust-list writes.
The x87 handle is returned to its actual acquisition allocator. Shared memory's
extra reference is decremented without invalidating the parent's pending-read
epoch; private memory is tainted before discard and never enters ordinary reuse.
The acquisition branch, not the current count, determines shared versus private;
unexpected counts reject retirement rather than reclassifying another owner.

Failed actions remain `uncertain`, successful returns are recorded individually,
and unattempted actions stay distinct. A lazy Kernel failure set retains the
unregistered Task and resource evidence. It blocks initial-mount retirement and
private Worker's global Kernel-reference release. This evidence authorizes no
retry. Repeated failures retain additional records/resources, an explicit failure
cost rather than a bounded-memory success claim. Taint is not host-stop proof.
Pooled-instance attachment failures, changed identities/generation, and unknown
backend readers remain quarantined. Other constructor/Task acquisition failures,
later register setup, copyLive or publication failures are separate gates. PID
reservations are not rolled back or reused by this change.

Focused actual Wasm/CPU preparation tests: 20 pass. Actual current muk inline
rehearsal, injected unresolved-preparation ownership, and Node rehearsal: 3 pass.
The injected ownership case tests the release gate, not an actual child trap in
that host integration. These runs use the historical translator artifact and
current core/muk; no current-source translator, browser or desktop claim.
Focused runtime strict TypeScript and Worker boundary strict TypeScript pass.
Family/PID/Task/FD preparation regressions: 86 pass (~0.85 s). Normal successful
fork adds scalar/reference captures and one memory-epoch read; no new payload
copy or mapping scan. Failure cleanup checks only known owner collections and
releases acquired resources; it does not claim to enumerate arbitrary raw aliases.
Independent source review found two missing ownership checks: backend cleanup
could replace the x87 handle, and missing cgroup membership was called returned.
Captured-handle versus retired-zero state is now checked and free uses only the
captured handle; cgroup requires membership and successful delete. New injected
counterexamples pass: final preparation/CPU total 22, strict TypeScript passes.
Final review reports no additional blocking issue within this limited scope.
