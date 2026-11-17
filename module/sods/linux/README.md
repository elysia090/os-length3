# Linux execution domain

This crate is the initial internal migration unit for Rust-owned Linux semantics.
It is separate from the x86-64 translator (`../src`) and regular-file payload
storage (`../file-store`). It is not a general-purpose `core` directory.

The private single-action lifecycle and bounded memory-admission table are implemented. It consumes
permission before host execution, retains uncertain completion, accepts cumulative
prefix evidence, and refuses stale/duplicate actions. `Completion::Stopped` requires
both no further effects and ended access; a confirmed byte count alone does not.

The private wasm32 ABI (version 2) connects that table to `runtime/linux/memory-host.ts`, which
creates and retains actual engine memories without exposing raw memory or callbacks.
Capture/write/grow operations acquire admission before host access. Mutation reserves
exclusively before execution; successful retirement publishes a new binding identity.
Unknown completion keeps the obligation and consumes bounded capacity. A memory
binding is domain-local, not a process identity; ordinary guest writes are not locked.

This is **not yet connected to Linux guest execution or the public runtime**. The
translator import/operator validation, exec/restore/Worker bindings, full domain
allocator and caller migration remain absent. No claim of end-to-end guest lifetime
safety or production TS thinning follows from the adapter. Host artifact checks only
check import/export shape; they do not validate arbitrary module behavior.

Memory/action limits allocate bounded records at initialization. Lookups are bounded
linear scans, O(M + A), not claimed constant-time or optimal. Capture makes one owned
snapshot; write first captures caller bytes then stores them, adding a copy versus a
proved direct source. Grow serializes against active spans. Memory unbind is absent,
so a domain refuses new bindings at its limit rather than growing indefinitely.
Unexpected host exceptions conservatively quarantine the action/binding; no recovery
or automatic retry is claimed. A finished byte count never alone permits release.

A future domain must own exactly one sequence issuer for its unique domain ID.
Each pending operation owns its action and backing/reservation obligations; dropping
this Rust record alone is not permission to release backing. Host callbacks must
not start before `start` succeeds, and a thrown/unknown operation is never reissued.
No completion here proves that other owners or an entire domain can be freed.

Local, dependency-free state tests:

```sh
cargo test --offline --manifest-path module/sods/linux/Cargo.toml
```

These tests do not validate a real Worker, shared-memory observation, browser,
translator artifact, or Linux guest. The next integration must test those actual
boundaries rather than treating this state machine as a usable runtime.

Private ABI integration test with an explicitly built artifact:

```sh
cargo build --offline --target wasm32-unknown-unknown --manifest-path module/sods/linux/Cargo.toml
SODS_LINUX_WASM=<path-to-sods_linux.wasm> node --test module/sods/test/runtime/memory-host.test.ts
```

The real-engine tests cover shared and unshared memory objects, not concurrent guest
writers or cross-Worker visibility. Missing artifact skips those tests explicitly.

## Prepared-root inode ownership (internal)

`inode.rs` now owns directory entries, inode identity and basic metadata while
embedding the existing file-store payload library. Hardlinks share an inode and
one payload. Sizes and lazy-attempt state are queried from that payload owner,
not copied into a mutable Linux shadow. Byte-component names keep the future
Linux boundary independent of UTF-8 path encoding. The payload's standalone Wasm
ABI is disabled for this dependency, but remains enabled for standalone builds.

The builder operates on parent inode plus one component, not guest paths. Each
operation preserves published logical state/input ownership on failure; a whole
mount is not a transaction and failed allocation may leave reserved capacity.
Existing directory modes can update; files/symlinks cannot replace existing names.
Root overlay/origin hydration, permission resolution, guest FD/mapping/Image integration,
source-registry retirement, and Node/muk caller switching are still absent.
The future Rust domain must uniquely allocate Tree owner IDs before connection.

Directory nlink uses 2 plus child directories, matching the current TS Dir.
Lookup is side-effect-free, unlike the old mount has operation that may create
parents. This lookup difference is not presented as transparent legacy compatibility.

Counts bound inode/entry records, not total heap usage. Payload length limits do
not bound total payload bytes or Vec capacity; ownership transfer can retain spare
capacity. Node storage reserves max_inodes initially. Directory hash indexing avoids the
previous unconditional quadratic sibling scans: expected construction is O(B + N)
for N entries and B name bytes, with O(B + N) retained name/entry storage. Reservation
and name allocation precede payload acquisition; publication does not allocate.
These are expected hash-table costs, not adversarial worst-case guarantees. The
Wasm target's RandomState entropy strength is not established; colliding names can
still cause quadratic work within admission limits. No directory enumeration API
is provided here. Legacy getdents sorts names and resumes after the last name, not
insertion order; its sort cost and string-versus-byte ordering need separate review.
This is a semantic migration unit, not an optimized or usable Linux replacement.

## Descriptor ownership (internal)

`descriptor.rs` keeps prepared filesystem storage, open descriptions and descriptor
tables in one Rust owner. Trees cannot be taken out or individually disposed
while their descriptions remain. This owner is not a Kernel: PID/IPC, credentials,
mount namespaces and process termination decisions do not belong here.

FD numbers are reusable positions in a table, not description identities. Separate
opens have separate offsets; dup and a copied table share a description and its
offset revision. A shared table has independent holder accounting. CLOEXEC belongs
to its slot rather than the shared description. Internal handles must reject stale
or foreign generations; exhaustion must not wrap them into an old identity.

These descriptor operations do not implement guest open/openat, permission checks,
mounted path resolution, console/pipe/socket finalizers or guest read syscalls.
The resident-only private copy pipeline below is connected separately.
Closing the last description does not reclaim its inode payload: namespace,
mapping, image and source ownership still need the full migration. The Node and
muk callers continue using the existing TS runtime; no production TS deletion is
claimed for this internal stage.

Tables use sparse maps rather than allocating the full FD-number limit. Limits
cover table/description record counts and total live slots, not exact allocated
bytes: Vec and HashMap spare capacity can exceed live counts and is retained.
Fork copies live slots and aggregates all reference increments before publication,
but map iteration scans retained capacity; expected work is O(source capacity +
live slots), plus the table arena scan. It also reserves a temporary count map
for up to the live-slot count. Lowest-free FD search can scan to the table limit;
open admission scans the description arena. These gaps from the necessary
O(live slots) fork work are explicit, not claimed optimal.

Table holder tickets are non-Copy/non-Clone; share creates a ticket and let_go
consumes it. Dropping a ticket without let_go retains the table until Files drops.
The embedding must allocate unique owner incarnations and retire all tickets.
Neither a Rust handle nor a guest FD number alone proves an external operation
has stopped. The resident-only pending references described below do not yet provide lazy
source, process/image lifetime or asynchronous guest syscall integration.

Passing a holder to the wrong Files rejects it but consumes that ticket, retaining
its original table. This is an internal misuse limitation, not a public recovery
contract; a public release API must preserve recoverability before exposure.


## Resident file to physical memory (private ABI 2)

The same Wasm instance now owns Files, memory admission and finite pending reads.
The component builder uses bounded name/input staging; file input is transferred
into the payload owner without another payload copy. A one-way seal creates the
bootstrap FD table. Source mutations and reinitialization are then refused. This
is an ordinary preparation port, not a hard-coded sample-file generator, but it
still lacks full archive/root-overlay and guest path integration.

A read resolves the description once, retains it independently of FD slots and
reserves its offset. Actual resident length, offset arithmetic and the next
revision are checked before any effect. A failed destination admission releases
that preparation without changing the offset. Closing/reusing the original FD
cannot retarget the pending operation. Another open of the same inode has an
independent offset; dup shares the reserved description. Busy is an internal
admission result, not an invented guest errno.

`read_start` consumes copy permission and exposes a numerical canonical payload
span only for the private host's short synchronous copy interval. The host reads
scalar results, then creates fresh views and uses captured physical intrinsics:
no callback, await or further core call between view creation and the copy. No
view escapes. Source mutation is forbidden by seal; allocating/mutating exports
are refused during the short interval. Generic action exports cannot interfere
with read-owned tokens. ABI u64 results use `BigInt.asUintN(64, result)` because
Wasm i64 values are returned to JavaScript as signed BigInts.

A stopped receipt atomically commits its confirmed prefix to the original OFD and
releases its backing obligations. Ready cancellation releases without effects.
Finished/cancelled results remain queryable until explicit read retirement, without
holding a memory lease just to await observation. Unknown ends the host's short
core-view interval (the private host must have stopped using the view before
reporting it) but retains source/description/offset reservation and guest
memory lifetime obligations; it never permits a second copy. Later monotone stopped
evidence can settle that same operation. Invalid/stale/duplicate receipts must not
release another operation. Generic memory growth may proceed once its relevant
backing obligation ends, not merely because a byte count was reported.

For a resident, sealed, non-alias source this delivery performs one N-byte copy
from canonical payload to physical guest memory, with constant-size per-read
records and no N-byte read snapshot. It is not atomic against concurrent writers
to shared guest memory. Preparation still captures caller input and copies it into
Wasm input storage; allocation/initialization and staging retention are not free.
Read/action/memory tables still use bounded linear lookup, and terminal records
consume read capacity until retired. These are not universal lower-bound claims.

Real-engine tests cover copy into shared/unshared Memory objects, close/reuse,
ready cancellation, late stopped evidence after a partially copied unknown result,
EOF without a destination view, sealed mutation rejection and generic-token
interference. Protocol fault injection is distinct from actual guest execution or a shared
Worker failure/stop test. Late receipt reconciliation is currently available only
at the private raw ABI, not through the host facade. Input buffer resizing can
temporarily retain both old and new allocations. Zero requested length still
requires a valid FD and known binding in this private path; a guest zero-read
fast path is not implemented.
The bootstrap table, resident source and one segment are deliberate restrictions:
access flags, lazy source actions, process/image generations, readv progression,
mount-aware paths and real Node/muk caller switching remain unimplemented. No
production TS Linux authority has yet been removed by this private pipeline.

## Filesystem storage identity before mount views

`filesystem.rs` owns the prepared Trees used by Files. An inode includes its
filesystem incarnation as well as its tree-local number: equal inode numbers in
two filesystems must not select the same payload. Description reads route through
this same owner, not a parallel TS inode map. Additional filesystem admission is
bounded by total Tree count, reserves storage before transfer, and returns the
unchanged incoming Tree on duplicate identity or capacity/allocation failure.
Duplicate identity is checked before capacity; it never replaces existing storage.

The bootstrap Tree stays inline and additional Trees use an owner-keyed map. This
asymmetry preserves the existing infallible, allocation-free Files construction
and seal failure contract. A uniform map would require a fallible initial insertion
and returning Tree ownership through that constructor. This is an internal choice,
not a public two-class filesystem model. Routing costs one bootstrap identity check
and expected constant map probes for another filesystem; hash collisions remain
a worst-case limitation. Admission moves Tree ownership, not payload bytes.

Storage currently remains until Files drops. There is deliberately no removal,
replacement or mutable Tree export. This prevents a pending read from losing its
source, but does not solve per-filesystem reclamation. Count limits do not bound
payload bytes or retained map capacity. The private Wasm builder still admits one
bootstrap Tree; additional filesystems are exercised through Rust Files tests, not
yet through a guest mount syscall or new host export.

The next connection must distinguish mount views from filesystem storage. A bind
mount shares inode/payload but has its own topology and flags; namespace detach
cannot free storage held by an open description, cwd/root or pending operation.
A Tree-only path resolver or a TS-resolved inode passed to Rust would leave the
mount authority split. The acceptance target remains actual muk mount setup, guest
path open and the same Rust description's read/close, followed by corresponding
TS authority removal. That target is not yet implemented.

Tests distinguish equal inode numbers across three filesystems and preserve payload
pointers through pending-read admission, close and failed registration. They do not
prove that a rehash occurs or permit allocation during a live Wasm host view: any
future admission export must retain that copy interval's mutation exclusion. Owner
collision rejection is not protection against forged equal owner/number handles;
a domain-unique incarnation issuer is still required before guest connection.

## Mount positions held by descriptions (internal only)

Files can now establish one private bootstrap namespace over an admitted filesystem
root. Its `mount.rs` resources distinguish a view from the underlying filesystem.
Opaque positions are obtained only from view roots and direct component lookups;
there is no arbitrary inode-to-view conversion. An admitted second filesystem can
supply a detached root view. Bind views can share payload while retaining distinct
identity and location. Names/parent provenance for file binds are retained rather
than reconstructed from inode identity alone.

A position is not an ownership ticket. A non-Copy view ticket keeps a detached view
alive; attachment borrows that ticket, adds a topology edge, and leaves the ticket
usable on success or failure. A description acquires exactly one mount hold after
all other open admission. Dup, fork and pending reads share the description rather
than acquiring extra mount holds. Its final reference releases the hold. Thus
closing every FD during a pending read does not retire that read's detached view.
Namespace attachment and the bootstrap root have ownership independent of tickets.
Old positions reject retired/reused generations. Explicit ticket release is needed;
dropping a ticket conservatively retains its hold until Files itself is dropped.

Only private leaf views are supported here. Attach requires a destination in the
bootstrap/attached topology and matching directory/file type; collisions and root
overmounts reject. Clone/detach of a view with child mounts also reject. There is
no stacking, recursive clone/detach, propagation, mount flags, pivot, full
symlink/path traversal, credentials or guest mount syscall implementation.
FsContext root/cwd ownership and internal parent traversal are described below.
Detached live positions may be used while their view is explicitly held; a bare
position alone cannot prevent retirement. Filesystem payload storage still remains
until Files drops, independently of view retirement.

The sealed-resident ABI2 bare-inode open remains a separate validation mode. Mount
bootstrap refuses existing live descriptions (including pending reads after their
last FD closes), and bare-inode open refuses once mounts are active. This avoids
quietly mixing descriptions without mount ownership into the new path. No mount
operations have been exported through the host/Wasm ABI yet; the new integration
is tested through Rust Files and its actual read reservations, not guest execution.

Admission preflights capacity, generation, type, topology and fallible name capture
before publication. Failure can retain reserved allocation capacity but does not
publish an FD/hold or change topology. Limits bound view records and explicit holds,
not all heap bytes/spare allocation. This first implementation scans a bounded arena
for vacancies, coverage and children, O(view high water), and copies location names.
It does not claim the path/namespace lower bound or constant-time attach. View
creation and retirement do not copy payloads or repeat path resolution on each read.
Corresponding production TS mount/FD authority is still present until the full
caller cutover, not removed merely by these internal operations.

The internal detach is lazy-detach-like: existing holds do not make it fail with
EBUSY, so it is not ordinary umount semantics. A live position conveys neither
permission nor process root/cwd ownership. Component lookup also scans the mount
arena and copies a name; a future K-component walk using it unchanged can cost
O(K * mount high water + name bytes), above the necessary path-inspection work.
That indexing debt must be evaluated before claiming a production fast path.

## Filesystem contexts and read ownership (internal)

`fs_context.rs` models the CLONE_FS sharing unit: root and cwd each own a mount
hold, even when both positions coincide, together with one shared umask. Sharing a
context increments its holder count, not its mount holds. Copying creates a separate
context and acquires both holds before publication; a failed second acquisition
releases the first. Root/cwd replacement acquires its new hold before replacing and
releasing the old one. A validated, exactly equal view/inode/parent/name position
is a no-op, avoiding a transient hold and name allocation; equal inode alone is
not sufficient. Task credentials, descriptor-table sharing and address-space
sharing are separate and have not been folded into this context. Explicit context
capacity is independent of FD-table capacity; the existing ABI2 sets it to zero.

Files owns the context arena and exposes no mutable context/hold. A context can
select root/cwd for component lookup, then open a mounted description and use the
existing read reservation. Dropping a context ticket without explicit release keeps
its ownership until Files drops. Released slots change generation before reuse.
Root/cwd ownership alone is not chdir/chroot permission checking, path confinement,
namespace/pivot integration or Task execution. Those guest contracts remain absent.

The pending-read coordinator no longer owns a single Files/table pair. The private
Wasm state instead owns Files, its bootstrap table and Reads together, allowing the
Rust coordinator to take the selected table without adding a TS descriptor shadow.
The coordinator checks its Files incarnation before every backing/effect operation;
wrong-incarnation calls do not start, cancel or acknowledge another operation. This
still relies on the embedding's unique, non-reused Files IDs. Numeric ID equality
is not protection against a forged second Files with that ID. The current sealed
Wasm owner does not allow Files replacement. A general Task/domain identity issuer
and real execution/image binding are still prerequisites for guest connection.

No Rust borrow is held across a host callback or wait. A pending operation retains
its original OFD and memory action; completion never re-resolves a reused fd in a
current table. Unknown access remains held until stopped evidence, while terminal
query records need no backing reference. Merely dropping State is not evidence of
external access completion. No new host export or production TS deletion follows
from this ownership refactor.

Contexts use a bounded reusable arena with generation checks. Admission scans its
record high water; sharing and umask changes do not duplicate root/cwd names. Copy
needs the two new hold locations, while component lookup borrows its held starting
position instead of capturing its name again. Changing to an exactly equal position
still compares provenance bytes. These costs and the mount lookup scan remain
separate from guest payload delivery and are not claimed optimal. The read
coordinator also requires the same memory Domain throughout an operation; the
sealed State enforces this pairing, not a general caller-selected resource API.

## Internal parent traversal

Directory storage retains its unique parent and byte name; files and hardlinks
have no such unique location. The extra retained directory names cost O(total
directory-name bytes). Parent and symlink target queries borrow storage rather
than scan siblings or copy their bytes. Rename/unlink are still absent.

`Files::fs_parent` now follows mount topology under a borrowed Fs root. Location
equality for confinement is view incarnation plus inode, not the route's name.
The root is checked before and after crossing an attached view: a bind root's
parent comes from its attachment point, not from its source directory. A live
detached view root stays fixed. Files are rejected before even root clamping.
After a storage-parent step, current mount coverage is applied unless the parent
is already the Fs root. Foreign/stale views reject rather than becoming an escape.

Crossing borrows attachment positions without intermediate name allocations;
only the final returned position copies provenance. Coverage still scans mount
high water, O(M), in addition to the number of crossed boundaries and storage
lookups. No constant-time or allocation-free path claim follows. Tests connect
returned positions through component lookup, open and resident read, but this is
not a guest `..` syscall: search permissions, symlinks, NO_XDEV, BENEATH/IN_ROOT,
full path validation and actual Node caller cutover remain unimplemented.

## Private lazy reads and execution image identity

The resident ABI above remains unchanged. A separate managed read path now ties
its pending operation to a Rust execution/image snapshot and original OFD before
calling a source. Source ID, loaded state and attempt identity remain in the
file-store; a nonzero source ID does not mean a loaded payload must be loaded again.
The private adapter transports source bytes and actual engine Memory objects, not
Linux offsets, loader state or execution decisions. Node readFileSync delivery is
covered through this same adapter, but the normal Node guest runner is not switched.

Requested memory range is checked before any load attempt. This is an exact private
range contract, not guest read's partial-range clamp, access flags or errno order.
After loading, actual source size determines the copy length. The original image,
binding and execution are checked again before copy admission. Foreign execution
or domain selection rejects without retiring somebody else's operation; a changed
image of the same owner fails the old read before destination access. A failed
staging allocation settles a stopped matching source attempt rather than leaving
its OFD reserved. Stale completion never adopts input or changes a new attempt.

Ready load cancellation retires an unstarted attempt. Once host source work starts,
cancellation records intent but retains the attempt/OFD until its stopped result.
Late cancelled bytes are discarded, not cached or delivered. Source reentry retains
the existing file-store poison behavior. Same-OFD seek/read conflicts are refused
by the reservation: this is an intentional difference from legacy raw callbacks
that mutate offset and then fail the read's identity check. No guest errno or raw
callback compatibility is claimed by that private refusal.

The image owner distinguishes successful initialization, proven untouched failure,
poisoned-but-stopped initialization, and unknown completion. Partial initialization
never restores an old runnable image. Generic physical growth cannot retire an
execution-owned binding behind that owner's back. Image writes in the private host
are bounded memory-prefix initialization, not ELF loading, a translated module or
a stack/auxv constructor. A failed initial admission can consume bounded execution
capacity until its State ends; no automatic owner recycling is implemented.

Rust also has a separate run lifetime hold, not a zero-byte copy effect. An exit
request is not stop evidence; only a matching invocation's unwind can release the
hold. Unknown retains it, while syscall read spans may coexist. These run transitions
now connect to the fixed-memory read/exit diagnostic described below. Normal Node
Worker stop receipts and the complete guest profile are not connected.
Execution ownership is not yet bound to a Task's FD/Fs/credentials and namespace.

There is no mutable payload/eviction export in this sealed path. Its source safety
comes from the Store attempt, original OFD and Files lifetime, not a general inode
write lock. Future write/truncate/mapping/eviction must acquire shared source
exclusion before exposure. A short canonical view blocks all allocation/image/load
exports; unknown copy retains source and guest obligations. Unexpected cleanup
failure can quarantine a bounded pending slot until State ends, not silently free it.

First load requires stable host capture when necessary plus S input bytes into
Wasm, followed by n bytes from canonical payload to the guest Memory. Adopting the
input Vec avoids an additional S-byte scratch-to-payload copy. Warm reads omit
source transport. Record lookups still scan bounded tables; no universal optimum
or atomic shared-memory snapshot is claimed. The new production TS is physical
image/source transport and opaque handle associations. Corresponding old TS Linux
semantics have not yet been removed: guest admission, translator validation, real
Node/Worker execution, credentials and the complete caller cutover remain gates.


## Fixed-memory translated guest diagnostic

A frozen old-translator fixture now runs through the same Rust execution, syscall
continuation, read and OFD owners. Rust chooses read/exit handling, target-range
clipping, errors, next PC, and asynchronous RAX/RCX restoration. The host performs
physical engine operations and reports matching stack unwind; an exit request
alone does not retire the run hold. Resident reads copy inside the paused import
and return synchronously. Lazy reads unwind once, fetch the source, copy the
canonical bytes, apply Rust's resume command and continue at the saved next PC.
They do not reissue the syscall. Unknown copy or resume completion retains owners.

The first profile has fresh nonshared memory with initial equal to maximum, one
runner, no start function, no defined extra memory and only known import names and
kinds. It is not a general bytecode sandbox: expected signatures and translated
instruction semantics still require trusted translator provenance. Internal
memory.grow is not claimed absent; nonzero growth cannot extend this memory, and
zero growth may replace its buffer. Every short copy takes fresh views and cannot
reenter the guest. Raw instances, memory, globals and executable tables do not
escape. Active data is applied under exclusive image admission. Initialization
failure may retain bounded Rust owner capacity until the whole State is dropped.

Tests cover a guest reading `abcd` and checking it before exit, resident and
synchronous/asynchronous lazy sources, source failure without offset advancement,
read ownership, duplicate image owners and wrong-source completion. The fixture's
old translator identity is recorded beside it; this does not prove a current-source
release, default Node Worker, ELF stack/auxv, paths, credentials, dynamic translation,
shared memory, signals or a complete syscall set. Old production TS Linux authority
has not yet been deleted. This is a tested connection step, not a narrowed product
completion claim.

For an n-byte resident read, canonical-to-guest transfer remains n bytes with no
source fetch and no extra byte-sized staging. The diagnostic uses several constant
control crossings for syscall admission, query, copy receipt and completion; these
have not been demonstrated minimal. Lazy initialization additionally transports S
source bytes into Wasm and, when input ownership is not transferred, captures S
host bytes. A pending continuation is inline and bounded to one per execution.
Bounded-table scans and translator/artifact costs remain separate from copy costs.

### Same authority with a Node guest Worker

The private diagnostic can now keep the Rust State on the main thread and execute
translated guest code in a separate Node Worker over fresh fixed shared memory.
The Worker imports no legacy Kernel/Process implementation and makes no decisions
about Linux syscall numbers, errno, descriptors or offsets. It publishes a request
and waits for a Rust-decided Return or Leave. This is not a default Node entry
switch: `run.ts`, full ELF startup, execution-owned credentials/FD/Fs creation and
the old production TS authority remain migration work.

There is one non-reused Worker, invocation and 88-byte request slot. The slot holds
invocation identity, nr/six arguments/next PC, a return value, publication state
and a non-wrapping sequence. Payload is published before the atomic state change;
waits recheck the predicate rather than treating notification as the result.
Guest read bytes are not copied through the message channel. Main copies n bytes
from the Rust canonical payload to shared guest memory while the Worker waits.
The wait is **not** stack unwind: RunHold stays live, and the translator performs
its normal RAX/RCX update when the synchronous import returns. This avoids a second
register-resume protocol on the Worker path. Central placement still incurs a
request/reply synchronization per syscall; it is not a universal performance floor.

Initialization validates raw module framing, externalizes data with the existing
translator adapter, rejects remaining data/start sections, checks all segment
ranges, and writes only inside image-change admission. Worker ready precedes
Installed/run admission. Initialization failure with uncertain Worker completion
retains the image action until an actual Node exit permits a stopped failure
receipt. Constructor failure without an exit witness is conservative quarantine,
not successful rollback. Shared growth beyond initial size is unavailable in this
profile; concurrent guest threads and growable memories have not been admitted.

Exit intent, matching guest unwind, Node exit, pending source completion and copy
completion are separate facts. A stop request or terminate promise does not prove
exit. A source callback remains observed after Worker exit; its matching completion
is attempted once, then terminal read cleanup is attempted again even when the
completion reports an identity failure. Late bytes are not adopted and staging is
cleared. The original OFD is held independently of its fd number, so close/reuse
cannot make late cleanup alter a replacement descriptor. Unknown main-side copy
still requires its own stopped-copy receipt even after the guest has stopped.

Local tests exercise real Node Workers with the Rust Wasm instance, successful
resident/lazy reads, source failure, reentry rejection, forced exit during source
loading and both late outcomes. Separate physical-channel tests cover initialization
failure and callback retention. The current-source translator CI test also runs
both inline and Worker profiles; local environments without that translator skip
only that explicitly unconfigured test, never substitute the frozen fixture.
These results do not yet establish normal Node startup, multiple execution sharing,
full syscall coverage, browser Workers or automatic whole-tree disposal.

## Initial stack integration (private fixed profile)

The same Worker diagnostic can now consume a stack built by Rust. Byte arguments
and environment entries retain order, duplicates and non-UTF-8 data. Internal NUL
is rejected; an empty argv becomes one empty argument. Executable path is separate
from argv[0]. Rust decides argc/pointer tables, auxv, absolute addresses and aligned
RSP using checked arithmetic; the host does not construct a second stack layout.
Only the live suffix is allocated and copied, not an entire stack-sized snapshot.

The private wire has a 2 MiB frame budget, 128 KiB per NUL-terminated string and
65,536 argument/environment pointers. These are explicit diagnostic admission
limits, **not** Linux RLIMIT_STACK/ARG_MAX compatibility. Facts, low/top and aux
credential values currently come from the diagnostic caller. Validation checks
representation, ranges and actual image-change extent; it does not authenticate
ELF facts or implement credential changes, path authorization or program loading.
The host rejects stack/image-segment overlap before mutation. Linear-memory gaps
are not protected guard pages. Production startup must derive these inputs from
its Rust-owned process and executable before it can use this path normally.

Input and output staging belong to one execution/image generation. Unknown image
completion revokes new initialization access; only a matching later stop can finish
the existing action. Stack bytes are copied synchronously during image admission,
without an intervening export or callback, then staging is cleared. The Worker
sets the Rust-selected RSP in the exported mutable i64 register before ready. A
missing/incorrect register cannot become a ready guest. Initialization/stop evidence
continues to use the existing Worker lifecycle, not promise success as proof of exit.

For B input string bytes and K entries, validation and writing require O(B+K)
work. This representation additionally holds a bounded host wire and core wire,
a borrowed-reference table, and the generated suffix while building. It transfers
the wire host-to-core and the suffix core-to-guest. These are the costs of the
current separate-heap ABI, not a universal lower bound. Qualification/provenance,
execution-specific FD/Fs and ordinary Node caller cutover still precede deletion
of the corresponding legacy TS semantic implementation.

A frozen historical-translator guest checks its own argc, raw argv, duplicate env,
aux credentials, execfn, random bytes and RSP alignment. Current-source translator
CI separately compiles and runs that source through the Worker. Passing the frozen
fixture alone is not evidence that the current translator or normal startup works.

## Execution-owned diagnostic descriptor holders

Execution creation now fixes its resource mode: a sealed diagnostic Files lends
one shared Table holder, or a memory-only execution has no file capability. Later
Files preparation cannot silently grant one. Managed reads and syscall dispatch
use that execution's holder, never a lookup of the current global table. This is
still the explicit preopened-file diagnostic; normal process Table/Fs/credentials
and namespace construction are not implemented by these variants.

Resource retirement stops at the execution holder. It requires an Exited/Failed
execution with no image change or live run, a settled continuation, and no read
record belonging to that execution (even a terminal observation must be retired).
Unknown copy, active loader and guest stop are independent obligations. A pending
answer retains ownership; a failed Table release restores the ticket. Retired IDs
cannot run, replace images or begin reads again and are not reused. Another shared
holder and a read-held OFD remain valid. Shared Files, its diagnostic base Table,
Tree, bounded execution history and physical memory are not freed by this result.

The Node adapter attempts this only after observed Worker exit and rechecks after
a late source completion. `resourcesRetired` means this bounded holder operation,
not whole-tree disposal or all engine memory reclaimed. Actual Node exit before
the first run has a separate receipt: it admits only an initialized execution that
has never started, with no run, image change or pending syscall. A stop request
alone cannot use it. Terminal retirement inspects the bounded
read arena (O(read capacity)); syscall dispatch gets its Table in constant time.
There is no per-read scan added to the ordinary path and no copied FD table, file
payload or mount graph for the diagnostic's shared holder.

### Prepared path authorization (internal migration)

Prepared metadata now receives explicit mode/uid/gid; kind and link count remain
Tree-owned. Immutable mount-view policy distinguishes `no_exec`, `no_suid` and
`no_symfollow`. It is not a Linux mount-flag bitmask: unsupported flags and profiles
must be handled at their admission boundary rather than ignored. Existing private
Wasm preparation still explicitly creates root-owned nodes.

The private path resolver reads the Fs root/cwd and Rust credentials, checks each
traversed directory, follows relative/absolute symlinks and clamps parent traversal
at the Fs root. This does not turn a cwd initially outside that root into a
BENEATH sandbox; startup must construct the intended root/cwd pair. Forty total
symlink traversals are permitted; trailing separators
require a directory. `no_symfollow` is checked on the traversed link's view. The
result is a nonholding Place, not authorization to execute or a safe asynchronous
source reference. Final regular-file/execute/noexec checks and a retained program
must precede loading and translation; that complete startup transaction is not
connected by this change.

Credentials are initial-user-namespace root or exec-derived private values. The
limited profile uses mode-only DAC and default securebits, excluding ACLs, file
capabilities, LSM/ptrace, idmapped mounts and unsafe shared exec. Exec computes a
proposal including saved/fs IDs, capabilities and secure aux values; it does not
publish credentials before image acceptance. Dumpability also observes old IDs,
ID changes and capability gains, independently of secureexec. This is not an
implementation of core dumping, pdeath-signal changes or full exec state updates.

Path processing borrows symlink targets in at most 41 frames instead of building
repeated concatenated paths. Existing mount coverage still scans the view table;
work is proportional to visited bytes plus components times that scan, and Place
provenance still allocates. No namespace snapshot, hidden FD table, duplicated
payload or host-provided permission decision is introduced. Normal Node startup,
program/source retention, process-owned Fs/credentials and deletion of the old TS
Linux authority remain migration gates, not completed capabilities.

The next private acquisition primitive retains the authorized Program's exact
mount/inode and credential proposal, without creating a file descriptor or an
open-file description. Store alone owns resident/lazy readiness and attempt
identity. A warm lazy source does not reload merely because its source ID remains.
Successful take-completion adopts the loader Vec without another payload copy;
program bytes are borrowed only for synchronous work. No pointer survives an
await or callback, and future payload mutation/eviction requires a new pin contract.

Foreign/stale completions cannot consume input; duplicate completion is not retried.
A loading Program cannot be released. Matching failure/poison can be retired after
source stop; unknown completion identity retains ownership. This primitive does
not decide whether a callback was dispatched, cancellation is safe, or execution
has become stale. The startup coordinator must establish those facts before a
failure completion. It is not enough that cancellation was requested.

The Program's proposed credentials remain unpublished. Translation identity,
initial-start slot ownership, physical image installation and atomic credential
adoption are still unconnected. In particular, no normal Node startup or legacy TS
semantic-authority deletion is claimed by these source-lifetime tests.
