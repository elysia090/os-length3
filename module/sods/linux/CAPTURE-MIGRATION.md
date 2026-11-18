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
