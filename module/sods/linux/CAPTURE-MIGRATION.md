# Captured output cutover plan (not an enabled profile)

The existing fixture proves a narrow in-memory acceptance path. It does
not install a product adapter, honor every Linux write/sendfile behavior, or
certify physical delivery. The ordinary host must keep rejecting fixture
markers. Production selection needs its own reviewed adapter and artifact.

## Where each responsibility belongs

- The Rust Core chooses the supported output profile, binds the exact output
  OFD to a bounded FIFO, validates invocation/sequence/length, and owns cursor
  and publication semantics. No output in a selected captured lane silently
  goes to borrowed physical stdio. Unsupported modes and pressure need an
  explicit contract; promising general nonblocking, pipe, signal or terminal
  behavior would require separate proof.
- The host constructs Node Workers/physical memories, transports the Rust
  command and original request, and observes actual unwind, exit and lexical
  access. These are engine operations, not duplicate Linux policies to move
  to Rust. Default borrowed stdio and the existing Kernel/RemoteKernel remain
  available until their actual callers migrate.
- A captured session owns Core, Files and lanes across producer retirement.
  Receiver authority is issued for the session/lane, not the guest FD or
  Worker. Closing admission is not discarding or returning EOF; accepted
  records and live reservations still belong to their owners. Temporary
  emptiness does not certify that all producers have stopped.

The first eligible host result is an independently owned byte array, with no
external I/O. Use a scalar peek of exact head identity and length, pre-admit
the final host allocation, then revalidate that head for one exclusive lexical
view. The trusted adapter copies once into the final allocation and settles
the same identity before notifying an application. No callback, growth,
await or other allocating Core call can execute while a view is exposed.
Uncertain access retains backing; known ended access with an unpublished
local copy may leave the original record available without claiming delivery.
No record can bypass an unresolved earlier head. A captured guest write then
needs a guest-to-Core and Core-to-host transfer, while an immutable file pin
needs only the latter. A one-transfer writable-host architecture would
require a different owner/cross-boundary commit contract, not a hidden copy.

The marker-rejected Worker fixture can test this boundary without selecting
a product adapter. Compare the exact lane, entry slot and nonreused entry
generation at start, with the JS adapter bound to one Core instance. Mint
a different nonreused attempt for each view, including a retry of the same
head. An earlier attempt's late receipt cannot unlock a new view. A global
guard must protect both the borrowed Files range and a copied queue entry:
discarding either head while its pointer is exposed is invalid. Unknown or
one-sided access is not a successful copy even at full count. After either,
only an exact explicit both-ended unpublished receipt can release the view;
it leaves the original head untouched. An ambiguous start or finish traps
the receive adapter for the whole Core, not just the affected lane. It must
not expose a result, infer a successful copy from emptiness or replay the
operation. A production adapter also needs to fence the rest of the affected
session; the fixture still exposes raw diagnostic operations for tests.
Raw Wasm view callers are trusted to exclude direct memory growth
and not to copy further after admitting uncertainty. This fixture does not
mint a stop fact about arbitrary code holding a Wasm buffer.

Keep scalar fixture routing out of the exact receive loan. A Rust head ticket
names the destination as well as the slot and generation: two registries
belonging to the same Files can have identical first lane/slot/generation.
Decode fixture scalars only after selecting the receiver of the same Core.
An independently held external frontier accepts offers or receipts through
its own exact ticket/action; it need not inspect or reborrow the Core payload
after escrow. The owned application result grants no native file or stop
authority.

## External sink is a different operation

Select and document what the sink can actually promise. For a narrow first
adapter, consider a synchronous operation on a handle owned and retained by
the sink session. A reported native accepted prefix is not disk durability,
peer arrival or terminal flush. A borrowed FD that can be closed/reused by
another owner is not such a proof. Do not hand an asynchronous sink a naked
view into Core. It needs its own independently owned backing before start.

One sink/session/lane/head/attempt identity owns the pending effect. Start
uses its permission once. Evidence scopes cumulative progress to that
offered range and separately proves ended access and no further effects.
Only the exact terminal combination can settle. Unknown, even at the full
byte count, keeps the applicable storage/credits/identity and blocks a
second offer or later head. Stop request, Worker exit, abort, empty capture
and drain callback are not interchangeable certificates. An exact stopped
partial result leaves a distinct unaccepted suffix; any policy to offer it
later needs a new, explicitly admitted operation. Never rewind the input
cursor or retroactively fabricate guest errno after capture acceptance.

Counterexamples for enabling any adapter: concurrent/reentrant caller,
stale head or attempt, allocation cancellation before copy, stop/exit during
copy, closure after acceptance, partial/zero/full progress without ended
access, ended access without stopped effects, late exact settlement after
cancellation, and later requests forbidden to overtake the pending head.
The fixture's real Worker exit and retained ABC are not substitutes.

### First sink experiment: keep one head charged

Use a single externally held head per lane, not an independently growing
host queue. The application-result path above consumes a head when it returns
owned bytes. A sink path instead needs a distinct copy settlement: after the
exact lexical copy ends, keep a frontier record and its Q/K charged until
the sink obligation resolves. It can release the Core payload and any R pin
at this point, because the sink only receives a private, already admitted host
allocation. Reject the handoff before exposing a view if that allocation or
its retained owner cannot be installed. At most one full head is temporarily
duplicated per lexical transfer. Allocator overhead and Files ownership are
not included in Q. Core emptiness or guest exit is never sink completion.

Keep sink policy in Rust: distinguish an unstarted buffered head, one active
offer, and an exact stopped suffix. For each offer keep the original head,
lane and nonreused attempt, associated with one stable owned sink in the
session. A receipt's progress is an absolute byte boundary in that head,
never a delta or an offset into the operating-system file. It must remain
between the offer's start and end and may not retreat. Even monotonic full
progress cannot remove the frontier until a single exact terminal receipt
confirms both ended access to the offered allocation and no later sink
effects for that attempt. A cancel request is not either fact. Incomplete or
contradictory evidence cannot release credits, replace the sink, close an
active handle, destroy backing, or start another offer.

An exact terminal partial receipt retains the full allocation and charge;
the suffix can use its original bytes and a new range, without compaction or
another payload copy. First report a stopped suffix, not an automatic retry.
Only a subsequent explicitly admitted offer may start at the confirmed
boundary, or an explicit policy may discard the residual. Later records
do not overtake either. Finish after an ambiguous start or result must be
reconciled through the exact owner, never by reissuing the native write.

The narrow candidate is a Node synchronous byte write to a private regular
file handle opened, held and closed by this sink session, with no exposed
numeric FD, competing writer, callback or async retention. An ordinary
successful native return can report its count plus ended access and no more
calls issuing effects for that offer; it says nothing about durability.
Unknown on exception is conservative until the chosen adapter can prove more.
Short results must be exercised with controlled test receipts even if a
small real file write is always full on this machine. This candidate does
not select stdout, sockets, pipes, Workerd or general Linux compatibility.

The native fixture exercises that ordering with the real Rust FIFO,
the existing one-shot `effect::Action`, and an independently retained native
payload. One witness writes to its own temporary regular file, bounds the
first call to an intentionally short prefix, and verifies that an explicit
second offer produces only the suffix. This is not physical delivery from
the Wasm/Node adapter.

For the marker-rejected Wasm connection, bind one lane once to one sink
owner in the Core instance. Binding makes that lane ineligible for the
application receive and diagnostic discard routes; other lanes are not
selected. Sink copy obtains the same exclusive lexical view as application
receive, but settlement places the exact head in external escrow instead of
consuming it. During an external offer no raw Core view remains: unrelated
Core or Worker retirement can proceed. Sink receipts must match the bound
lane, exact head and nonreused attempt. The owner of the physical handle
and independent JS allocation is the private Node adapter, not the Rust
guest, and Rust owns the turn, prefix and settlement rules.

Shutdown closes the lane's future admission and grants permission to close
the owned fixture handle only after all charged bytes are resolved. A live
reservation, external offer or stopped suffix keeps it open even if no view
or guest Worker remains. The fixture exercises an actual Node-owned temporary
file, a deliberately short write, and the currently translated Worker writing
ABC in FIFO order. That Worker writes A and uses resident sendfile for B on
stdout, then writes C on stderr. Only the stronger fixture's explicit joined
startup routes both logical descriptors to the same validated lane. A missing
registry does not admit an execution; failure after table installation leaves
the existing preparing owner to cancel without closing the shared lane.
Joined initialization admits only one queue and one independent receiver;
the old split control can still admit two. The split startup request on a
joined owner cannot claim an execution slot or create a physical fallback.
The consumer borrows the same sealed Files after the producer table retires.
Ordinary and separate-lane fixture startup remain available as controls.
This does not select a host profile, claim general Linux compatibility or
imply flush/durability.

## Gate for a real opt-in profile

Select the profile once, before constructing the session or Worker. Use a
separate lazy entry beside `managedRoot` in `runtime/linux.ts`; keep default
`managedRoot`, `memoryHost` and the default Worker's dispatcher unchanged by
this selection. Do not turn a fixture feature into a production profile by
allowing its marker through `memoryHost`. Build a separate non-fixture caller
artifact, reject combinations with probe features, and check exact catalog
provenance, a dedicated capture profile version, and its complete required ABI
before instantiation. A module can imitate export names; shape is not
provenance. Missing, wrong-version, ordinary and probe modules must fail before
any Worker construction, file creation or borrowed-stdio fallback.

Stage the artifact boundary separately from actual capture startup. The
first `capture-v1` build advertises only **candidate** admission. Before a
Core exists, the private Node verifier checks the exact byte length and
SHA-256 against a pin obtained from a trusted build/deployment catalog,
then checks the candidate wire version, imports and required exports on
the same owned snapshot. A digest supplied by the byte source itself is
not provenance. Reject repeated/shadow metadata and ordinary/probe exports;
never compile the bytes once and instantiate a separately supplied module.
The initial verification is deliberately not a public constructor. It
cannot start a Worker, create an output file, or provide a capture-ready
artifact. The normal `memoryHost` also refuses candidate modules before
instantiation.

The separate `capture-result-v1` build is a non-probe transport witness, not
an enabled application profile. It uses a distinct profile value (2) and
keeps its readiness flag closed. It installs one finite receiver on the
prepared Files before the same pathname/image/stack startup used by ordinary
execution. The corresponding typed write and exact resident sendfile share
the ordinary sequenced ingress and the same bounded lane. The one initial
transfer profile uses Q=4, K=3, R=1 and the same limited exact-count operation
range as the witness. It makes no claim about arbitrary write sizes,
asynchronous files, general sendfile offsets or a terminal session.

A trusted private Node relay in the tests verifies the exact build pin and
uses the existing client Worker/translation. It gets an independently owned
byte result only after an exact copy receipt, even after the actual Worker
and FD table have stopped. There is no physical output or sink ABI in that
artifact. Its result belongs to the receiving application, not the guest or
the underlying Core memory. A missed or ambiguous view receipt still keeps
the guard/queue owner. Both default admission and the old Node-file candidate
verifier reject this profile. Before exposing an ordinary application opt-in,
prove host wiring and candidate pin catalog provenance separately; maintain
default behavior and delete a legacy TS path only after its actual callers
have switched.

The private result host now reuses the existing prepared-root/Worker path.
An independently supplied pin is read together with the artifact role; the
same owned bytes feed SHA-256 and WebAssembly compilation. Wrong role,
length, digest, backing or ABI cannot construct a result instance. Startup
does not borrow host stdio. Rust selects the captured command, and the host
only copies the exact stopped bytes and exposes them after receipt. Polling
an empty result does not certify Worker exit. No public loader, default
caller switch or deployment pin catalog is selected by this private witness.

An actual prepared-root guest writes the four-byte ELF header and then
attempts one more byte on stderr. With no consumer between requests this
fills Q exactly. The second request is refused, cannot reach borrowed
stdio, and does not retract the first result when the Worker stops. This
is an explicit failure witness, not a usable pressure protocol for a
terminal. A larger finite queue does not turn a wait-for-exit consumer
into a streaming consumer. To admit one, specify the bounded consumer
handoff or resumption mechanism, signal pressure without claiming success,
and prove that cancellation cannot renew a used request or discard output.

A native test now admits one waitable mutable write. It holds its original
invocation, Worker sequence, source action/span and exact output OFD without
a staged allocation or borrowed view. Only recoverable Q/K pressure may wait:
a request larger than Q, or a full but unpublished lane, cannot rely on a
consumer advancing. A matching resume rechecks capacity without resending
the syscall or resolving the numeric FD again. Cancellation before staging
releases that exact unstarted action and hold; it neither revokes accepted
heads nor asserts that the Worker stopped. Rust also checks R before
reserving a K record for resident sends, so a pin shortage cannot consume
its last generation on a reserve/cancel round trip. A waiting resident send
needs its own exact source/cursor contract.

Private result wire version 2 carries the retained write's sequence and
action, not a new syscall, address, FD or payload view. The resume operation
matches that tuple and the same execution and performs no capture until
there really is Q/K room. A confirmed owned receive frees capacity; a peek,
an active view or an ended-but-unpublished receive cannot. A first live
view still excludes other Core operations. Artifact wire version 1 cannot
be replayed as matching the new command surface, even with a correct digest.
The non-draining private Worker host still refuses at capacity and closes
the exact held request.

The separate paced entry opts one active Worker into waiting, with at most
one blocked relay and one pressure observer on the selected session lane.
The caller waits for a pressure signal, then takes the regular owned result.
Only a confirmed consumer receipt wakes a blocked writer to recheck room.
The relay never resends the guest request or polls the Core or the Worker.
Stop request/observed exit can also wake it to cancel; neither is drain
credit. Recheck stopping after wake, before calling resume: a stop in the
same turn as a consume must not stage another write. Worker settlement and
FD retirement are observed separately; neither takes accepted result bytes
away. The signal reports pressure, not readiness of every queued result
or EOF. This is a pull-during-pressure witness, not a product streaming
subscription or a physical sink adapter.

The native resident-sendfile experiment retains an exact original input OFD
and cursor revision with the existing exclusive read hold, and the original
output OFD with its lane hold. It does not retain a numeric FD lookup, a view,
a staged payload, Q/K/R credits or a guest-memory lease. Reclaimable pressure
must name published capacity, including a pin cell whose generation can
actually be reused; an absent or permanently exhausted credit is not a reason
to park. Invalid, cold or loading sources fail, never trigger a host load.
Matching acceptance takes Q/K/R, links one immutable prefix and commits the
same cursor in one synchronous turn. Cancellation returns both exact holds
without advancing either cursor or queue. The native controls replace both
FDs, try an aliased seek and stop the execution before late resume.

Wire 3 unifies pressure resumption around one selected active producer arm,
with separate write and resident owners and no per-execution resident slot.
The file reservation identity is not a guest-memory token. The original
sequence identifies the arm even if token numbers overlap. The actual
translated Worker sends A, resident B, resident D and C; the second send
waits for R, not just byte credit. Taking copied A cannot advance it; taking
pinned B allows exactly D and one cursor advance. Stopping first leaves
AB. This resident-source proof alone did not cover a lazy packaged file or
alter Linux's general sendfile or terminal semantics.

A new Store readiness observation does not call read or load_begin; probing
a cold or active source that way would start or poison the caller's load.
Its answer is about the current payload, not permission to pin it. Only the
sealed Files owner can use readiness to retain a canonical immutable range:
that interface does not expose mutation, eviction or replacement after one
matching load commits. Ready-only cursor admission leaves a cold or loading
inode's source, cursor and reservation sequence unchanged. Existing ordinary
read/load and the old resident-only read ABI keep their source policy.

The selected result transport also checks lane capacity without spending a
K generation before the exact source is ready. A same-turn credit plan can
be consumed only through the exclusive writer; it does not survive a wait.
A bad source cannot allocate and cancel the last generation of an otherwise
free queue cell. Raw controls preserve source and destination ownership on
a waited send. On the normal prepared root, the actual translated Worker
reads its canonical ELF once before sending its fifth byte. That source can
then publish without a second load, including after Q is released; the
subsequent read observes the original OFD advanced once. One ready byte
also notifies without pressure. A cold send with no preceding read refuses,
starts no loader and publishes nothing. Cancellation leaves the first
already accepted chunk. This is ready-only equivalence, not readiness from
source availability, a general asynchronous loader or a default cutover.

The separate availability observer watches the selected lane, not the
producer's numerical FD or a pressure event. Rust marks an acceptance only
after publication and lexical access end, for both mutable writes and
resident sends. An already visible head satisfies a late observer; otherwise
peek and observer installation share one synchronous turn. The notice
neither owns the bytes nor says they were physically delivered, and a
consumer still takes the exact head. Producer end cancels that producer's
observer without telling the caller there can never be later output.

The private Linux x64 Node 22/24 distribution reader exercises the pin
chain end to end with a current-source result artifact and Worker. The
deployment owner must independently choose the current index SHA-256 and
size. That exact index names one capture role, content-addressed stored
gzip, and expanded Wasm SHA-256 and size. The transport validates index
and gzip identities and caps expansion at the declared size. The host
checks the exact expanded snapshot against the index's pin before
compiling that same snapshot. Neither a cache plan nor a blob reader
can change the selected role, digest or limits. This is not a signature
or rollback policy: the current index pin must come from the deployment
owner, not from the same untrusted provider.

The actual archive intake uses the independently reviewed web index digest
in pins.rs. It and the local distribution asset collector verify a declared
capture member's exact stored and expanded identities and bounds before
including it. The collector's same-source metadata check is only integrity,
not authorization to instantiate. A missing or incompatible selected member
fails collection; omission remains an ordinary archive. The distribution
builder can include the exact code only by explicit artifact path and trusted
digest, checked before reading the root or writing the archive. It preserves
the private Wasm marker and uses the normal content-addressed gzip writer;
an ordinary rebuild drops the optional blob and restores the ordinary index.
Offline inclusion is not a publication or a host selection. No release job
or default caller selects the private result fixture.

The candidate's Rust selector is a one-way admission latch, not output
initialization. A wrong selection does not unlock any file or execution
state. There are no borrowed-stdio, captured startup or diagnostic execution
creation exports in this artifact stage. A later explicit ready stage needs
its own contract. It requires the captured table/dispatcher, independent
host owner retention and real post-selection failures to be exercised before
exposing a facade.

Reuse validated translation/stack/Worker transport rather than maintaining a
second bootstrap. A capture-only startup path makes the Rust file descriptions
select captured output. Select the command handler once as well: the Rust
continuation owns which syscalls can reach the captured lane; the adapter
performs the guest copy and the bounded external sink transfer. Do not make
the default dispatch scan an optional capture lane on every syscall. Verify
the unchanged borrowed-stdio path and its generated work separately from the
explicit profile. Start with the proven Node owned-file behavior; Workerd and
browser retain their current paths until a replacement is verified there.

At that next boundary, the sequenced Rust syscall entrance must choose the
captured branch from the exact held output OFD, not from a syscall-number
table in TypeScript or a fresh lookup of the numeric FD after suspension.
Reuse `Continuation::admit_request` once per request, before first effect.
Move capture admission into the Rust dispatcher; return only a typed command
and exact action to the bridge. Unsupported operations, stale invocation,
closure and exhausted Q/K/R must not dispatch a physical command or prepare
the source. Probe-only syscall arbitration should then be removed from tests
that exercise the real adapter; independent raw rejection witnesses remain.

The rejected Worker artifact already places the admitted `WriteCall` in
the exact `Continuation`. Its raw fixture adapter retains only identifiers
and the lexical fence. Only the continuation may issue, settle or cancel
the call; generic retirement cannot retire a pending captured call without
its original lane context. No new owner or ABI is selected in `capture-v1`
by this step.

The stronger artifact's integration fixture now gives Rust the whole original
sequenced Worker request once. Rust chooses the narrow captured write or
resident sendfile branch and returns typed Write, Return, Path, or Exit; the
Node fixture no longer selects a syscall implementation by number. The
direct diagnostic exports remain only for independent raw counterexamples.
The selected ready path still needs to bind that dispatch to its captured
startup profile and remove the unused probe-only bridge when superseded.

Do not confuse one logical owner with an inline allocation requirement. In
the stronger wasm32 fixture, moving the 216-byte `WriteCall` inline raises
each `ExecutionSlot` from 1,888 to 2,104 bytes, while the single global State
shrinks by 192 bytes. Before scaling a ready artifact, compare a mutually
exclusive continuation owner layout or a bounded exact-ticket pool against
this fixture. Neither can be selected merely from the size estimate: late
settlement and pre-start closure must still retain the same exact owner.

Compare three shapes against that proof. A capture-only ready artifact can
omit the incompatible physical sendfile owner at compilation, but only if
startup and syscall policy prevent a physical sendfile route on every captured
descriptor. The mixed diagnostic artifact needs both behaviors for controls;
its byte-output owners can occupy a tagged union because a physical capability
ticket, including an unobserved terminal receipt, blocks new admission just as
a captured write does. Using an accessor for the wrong arm must neither see
nor replace the live owner. A bounded pool can save memory when execution
high-water greatly exceeds simultaneous output, but adds an exact lookup,
retirement and generation proof each time plus a new capacity policy. Measure
the union before paying or specifying that extra pool work. Keep the ordinary
physical-only artifact on its existing representation and compare its code.

The mixed fixture's measured wasm32 representation is now 616 bytes for the
optional tagged owner, the same as the physical owner alone. Its execution
slot is back to 1,888 bytes and the global lexical fence stays small. These
are compiler layout observations, not serialized ABI promises. This finding
does not select a pool or establish actual startup in the ready profile.

The next isolated comparison uses the existing non-probe candidate, not a
second runner or a new general abstraction. Compile its wasm32 continuation
with only `Option<WriteCall>` and exclude physical sendfile commands, exports
and view scans. Until captured ingress is wired, even a sequenced sendfile
cannot prepare a source through that artifact; startup remains unavailable.
Keep the mixed probe for the two-arm controls and the normal artifact for
physical capability rejection. Do not infer readiness from a smaller slot.
An accidentally supplied physical-output table must not cause a borrowed
write either. Physical stdin is separate: its actual admission remains
available, and a captured output is still not readable.

The measured capture-only candidate slot is 1,488 bytes, 400 below the
mixed slot. The optional captured write owner is 216 bytes and the complete
continuation is 936 bytes. Captured startup, receiver installation, and
host policy are not included in this observation. Before calling the ready
profile small, measure again with the actual lane/consumer/session state.

A product sink session must retain the whole exact Core and native/JS owners
through an ambiguous state and expose a bounded failure/retirement API. The
diagnostic helper is not that API: it simply refuses reuse on ambiguity.
Before any eventual deletion, confirm each migrated caller, including aliases
and failure cleanups, no longer references the old implementation. An opt-in
alone does not make any TypeScript file listed below unused.

## Removing TypeScript is gated by callers, not line count

Current capture work does not make a runtime TypeScript file unnecessary.
The existing now-duplicated-looking code must remain until the corresponding
set of entry points is retired or redirected with equivalent tests.
Once those callers and supported hosts are verified on the replacement, remove
the now-unnecessary TypeScript implementation and its obsolete references.
A cutover is not complete while it retains an unused fallback or a second
implementation for the same supported profile.

- Old Worker-only transport: `cpu.ts`, `channel.ts`, `worker-stop.ts`.
  Remove the group only after the current RemoteKernel consumers, Worker
  shims and old transport tests migrate or are explicitly removed. Moving
  one Node captured run does not migrate default browser/remote execution.
  `remote.ts` itself also has public and application consumers; retaining
  a compatibility facade means it was not deleted as a whole file.
- File operations and descriptor ownership: `sys-file.ts` and `fd.ts`
  still drive the legacy process and shared open descriptions. Migrate
  remaining file/namespace/error behavior, aliases and fork, sockets,
  pipes and terminals before removing whole files. Remove dispatch entries
  only once all applicable callers are routed to their proven Rust owners, not
  after just the bounded resident example.
- `memory-host.ts` and the current Node bridge retain physical transport and
  lifetime responsibilities. The negative-only sendfile relay may become
  removable after the rejection/cancellation rule and exact Rust cleanup
  are equivalent on the ordinary route. That would still not remove the
  host file. Keep physical stream helpers until their users are migrated.

For each actual removal, inventory import/export, dynamic Worker URL,
published package and host/test references; run the existing control and
negative tests as well as the new profile on its supported hosts. Do not
turn unknown Workerd/browser or public ABI callers into dead code by
assuming the Node diagnostic represents them.

## Current-caller equivalence gates

The fixed four-byte witness is not interchangeable with either caller.
The actual rootless managed CLI accepts single writes of 5 and 32 bytes and
keeps its borrowed stdout, stderr and stdin independent. The same five-byte
native ELF completes through that CLI and refuses before publishing any
result through the private capture host. On the actual shared RemoteKernel
Worker, whole-AOT commands retain a 13-byte output record, and copying the
fixture's canonical executable submits writes of up to 4096 bytes. The
legacy outbox can coalesce neighboring deliveries; console callback sizes
are not a syscall histogram. Its 64 KiB outbox accepts at most 16 KiB
per fast-path call and falls back to the kernel for larger calls. These
controlled sizes are positive compatibility requirements, not a workload
distribution or a justification for choosing 4096 as a limit.

Choose the first real caller before specifying separate byte (Q), record (K)
and pinned-range (R) limits. At minimum an exact-acceptance profile must fit
each call it promises to accept in an empty lane; a resident pin does not
make that requirement disappear. Returning a short prefix or splitting an
oversized request changes the guest contract and requires its own proof
under cancellation and real endpoint behavior. Buffered acceptance alone
is not a substitute for the managed CLI's external I/O or errno behavior.
Keep the maximum admitted request separate from retention: exact acceptance
requires max request <= Q; K also bounds the number of retained records,
and R is admission for canonical prefixes, not host-owned buffers.
A larger private policy needs an independently selected bound before Core
or Worker startup, and adversarial tests at zero, the bound and one over,
including short/error/no-progress controls. Neither one successful output
sample nor a larger Q selects a caller's semantics.

The output origin lost by a joined byte stream is an independent blocker
for both current callers. Preserve the immutable stdout/stderr destination
on the original OFD, not the current syscall FD; redirection and aliases
must not relabel an accepted record. One ordered queue with per-record
origin preserves ordering without separate Q/K/R pools and an arbitration
layer. A successful owned read is still not a physical receipt.

Native capture now stores the logical origin on the original captured OFD
and moves it with the exact reservation into its FIFO record. This is the
same question the current RemoteKernel's console description answers after
dup or close, not the outgoing guest FD number. The native control fills a
joined lane with stdout, redirects fd 1 to stderr, waits on a resident
prefix, and reuses fd 1 as input before resumption. The two outputs remain
stdout then stderr after closing the table, with one lane and no origin
lookup through a retired descriptor. The actual RemoteKernel control swaps
the stdio targets with dup/dup2: the first byte still reports stderr, and
the second reports the original stdout.

Private wire 4 returns the logical role with the exact head and its
matching copy loan; neither an unlabelled synthetic head nor the wrong
head identity can be reported as a named stream. The host checks metadata
again before the lexical copy, keeps one final owned record until receipt
and exposes its original role without a consumer-side FD lookup. The
private result reader now returns a record rather than retaining a byte-only
fallback. Guest dup/dup2, physical output, general size and the usual
caller switches are still separate gates. With the measured wasm32 compiler,
the in-arena cell stayed 32 bytes (the entry itself grew 20 to 24 bytes);
queue, file-description and execution-slot sizes also stayed the same.
This is a layout observation, not a new fixed representation contract.
No payload copy was added.

Treat ready-only file capture as a separate policy. A cold file must not
start or disturb another load until a real caller selects a cold-source
contract with its own completion/stop evidence. The normal prepared
read and existing RemoteKernel can materialize cold bytes for their own
semantic paths; the ready-only negative is not equivalence to those paths.

A RemoteKernel cutover must additionally compare the capabilities its real
consumers use: multiple/suspended Workers, read/input readiness, signals and
output flush epochs, pipes/TTY and Node versus actual browser/Workerd hosts.
The verified file-store binding and a successful Linux x64 Node witness do
not migrate any of those callers or retire their TS files.

### Selected width, not a blanket CLI limit

The private wire 5 requires the trusted embedding to choose maximum exact
request M and retained bytes Q separately, before compilation and startup.
Neither the artifact index, the returned blob, nor the guest chooses them.
The host snapshots both scalars and Rust checks `1 <= M <= Q <= 65536` before
allocating the exact receiver. The 64 KiB ceiling bounds this experiment's
logical bytes to one legacy outbox allocation; it is not the Linux or
RemoteKernel write limit. K=3 and R=1 remain independent fixed record/pin
limits. Queue metadata is provisioned at root initialization. Copied
payload allocation happens later on bounded admission, can still fail,
and is never promised or retried as pressure. A positive byte reply is
only exact capture acceptance. No hidden split or widening occurs.

A request of length zero or greater than M does not enter the producer
continuation or touch a resident source, even with spare Q. This private
negative is not normal Linux zero-write or errno equivalence. A request
that fits can wait only for published capacity that can be reused; when
the last-generation K record retires on consumption it cannot grant space.
Taking a record gives the receiver one independently owned allocation,
temporarily alongside the Core's bytes. Q is not a host heap ceiling and
does not bound how many detached records the application retains.

For the same ELF, an explicit M=4096/Q=8192 run reports separate intact
5-, 32- and 4096-byte records after retirement, in guest order. Native and
the actual `--managed` CLI accept the same requests and stream bytes.
The Q4 control still fails before accepting five. This proves the selected
examples, not CLI parity, unidentified larger calls or a default capacity.

For N accepted mutable bytes the stable snapshot requires at least N
bytes of guest-to-owner movement, and the independently owned JavaScript
result requires at least N bytes of owner-to-receiver movement. A pinned
ready-resident prefix skips the first movement but not the second. Choosing
M/Q adds no payload movement; staging still zeroes mutable storage before
its one guest copy and is not claimed to reach the initialization lower
bound. Failure before M admission requires neither payload movement.

### Physical input loan is not sink selection

Private wire 6 installs a physical input description only when the trusted
Linux x64 Node 22/24 embedding explicitly borrows its non-TTY fd 0. With
no loan, guest fd 0 is absent and may be used by a later open; captured
fd 1 and fd 2 keep their original identities. No synthetic stdin or
borrowed output description is created. The input adapter qualifies only
fd 0 and refuses both host outputs independently of guest FD state. The
embedding must not close, reuse or concurrently consume the native fd.
Guest close releases only a Rust slot. Blocking read has no asynchronous
stop claim before the one synchronous native call actually returns.

For a read, Rust checks the full target span before any irreversible
transfer, then borrows the exact native read into the paused guest view.
Short counts, EOF and the reviewed known-zero errno are distinguished
from unknown. No retry or additional payload copy is introduced by the
adapter; one Node call is not a promise about the number of OS syscalls.
An unclassifiable outcome does not authorize replay or reclamation. Actual
Node, native Linux and the current CLI agree on the known-zero bad input,
fault, zero length, six-byte short read, EOF and guest close controls.
Without a loan, an inherited input file retains its offset and contents.

An unwritable native stdout gives the same fixture EBADF on Linux and the
current CLI, which prevents the following stderr write. The captured result
accepts both records because it never performs that physical operation.
The real CLI has borrowing, return and flush/stop semantics this profile
does not inherit: no after-exit replay to stdout/stderr can replace exact
guest-visible outcome. A future explicit sink needs its own admitted
endpoint and effect token, finite host retention, exact count/errno/unknown
receipt, plus independent external access-ended evidence before reuse.
Separate accepted (Rust FIFO), detached (owned receiver), delivered (native
effect), and stopped (no further effect) when considering that design.
No default route or retained TS implementation can be switched on this
input-only result.

The current borrowed-output contract is observable on real pipes, not only
regular files. Controlled Linux x64 pipes held 8192 bytes with a 4096-byte
atomic unit. On both reviewed Node 22 and 24, the actual `--managed` CLI
returned `-EAGAIN` for a full nonblocking pipe with zero new bytes. Asking
for 8192 when only 4096 were free returned and physically wrote exactly
4096, after which the pipe held the preserved old page followed by the new
prefix. A closed peer returned `-EPIPE` to that CLI's guest; the same
standalone native ELF instead died from default SIGPIPE. The baseline for
a CLI cutover is the current CLI behavior, not a claim of full native
signal equivalence. The pipe sizes are controlled fixture values, not a
request, retention or batching policy.

This selects two different contracts for further experiments. An
asynchronous capture sink can consume one independently owned head under a
bounded escrow, preserving original origin, count, suffix and stop
evidence, but a previously acknowledged capture cannot return the later
physical error to its producer. A CLI-compatible route must provide the
actual result before replying to the paused syscall and must not retry an
unknown effect. For a compatible synchronous write, one positive native
effect plus exact completion evidence is necessary, but an extra owned
payload copy is not: a checked stopped guest view can be borrowed directly
for the exact call. A sealed resident prefix has the analogous no-staging
possibility if the original OFD and its short commit remain held. These
are work bounds and design constraints, not a chosen implementation,
latency result, or permission to mix the two routes.

### Qualify a physical sendfile endpoint before the source

Independent Linux x64 native controls compare the operations rather than
assuming that a successful `write` qualifies its endpoint for sendfile.
On a newly created writable regular file without append, native
`sendfile(NULL offset)` confirms zero at EOF and for a zero request, or
advances the original input by the positive prefix. On a writable file
opened with `O_APPEND`, native sendfile rejects all three with `EINVAL`
without advancing the cursor, but an ordinary write appends. In particular,
a regular-file stat, a non-TTY check, and zero offered bytes are not
qualification. A real nonblocking pipe already full gives `EAGAIN` and
does not advance the source; giving a pipe one 4096-byte page gives exactly
the same-sized positive prefix and advances only by that count. These
tests do not select arbitrary inherited regular files or pipes.

The native Rust witness uses the existing `Sendfile` owner, not another
cursor or queue. It exclusively creates a writable non-append file owned
for the full turn. Only the fixture's registered exact Files owner and
output endpoint can receive its capability response; another root with
the same endpoint number and a different endpoint of the same root are
rejected before any view. The originally held output survives replacement
of the guest FD with an ordinary file. A single synchronous native
`File::write` receives the canonical pointer without staging and the exact
receipt advances the source once. Too much confirmed progress cannot end
the view. Modeling observed guest termination after the real external call but
before its receipt still cannot settle the output guard.
A later exact receipt still commits the physically written prefix, without
replying to the already stopped guest. Surrounding writes give
`AabcdC` on that same file; the unrelated files stay empty.

That fixture supplies its one immutable live File-to-endpoint association;
it is not proof that an inherited host descriptor is non-append or that
two host objects cannot reuse a numeric FD. Do not expose its acceptance
in the ordinary Wasm exports. The next private host must own an
unreplaceable qualified handle until exact settlement or quarantine; have
a narrow creation path, not an application-provided proof boolean; and
locally exclude any new effect after stopping. A stopped known-zero
receipt and an unknown receipt remain different. Until the host proves
that distinction, a positive count is not a Linux-wide errno/pipe/TTY
contract. This witness demonstrates one physical write API call and no
additional resident payload copy, not elapsed-time parity or a guarantee
of one kernel syscall.

The marker-rejected artifact also exercises that same direct sequence with
a current-source translated Node Worker. All three requests use one
endpoint in its Rust stdio table. The witness translates that endpoint to
the privately created exclusive file, never the inherited stdout. There
are two direct guest-memory writes and one direct canonical-Core write,
not a copied FIFO followed by replay. A successful result is `ABC` and
the unconsumed source suffix stays `D`. The stop variant shows `AB`:
the Worker is observed stopped before its host request settles; a
conservative prefix/access-only receipt still cannot retire it until
the matching stopped receipt arrives. No byte is replayed. Qualification
at this raw boundary remains explicitly synthetic; a real Node file and
real Worker do not turn that probe into product admission.
