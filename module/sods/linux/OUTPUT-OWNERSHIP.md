# Private source-range publication foundation

This is an internal foundation, not a captured-output API, Linux pipe, accepted
physical sendfile capability or terminal compatibility. The production Worker
still rejects sendfile before source/output. No new native artifact is selected.

## Read reservation incarnation

An OFD offset/revision does not identify a read attempt. Aborting a preparation
leaves both unchanged, so a later admission can select the same bytes with the
same proposed next revision. A durable source-range owner must not mistake that
later attempt for the old one.

Files now assigns a distinct nonzero reservation to every admitted read,
including count0 and later-aborted attempts. The OFD's reading state contains
that identity, carried unchanged from ReadPreparation to ReadHold. Preparation
checks and finish/abort match the exact incarnation. Identity exhaustion refuses
admission before changing description refs or locks and never wraps. This is
internal provenance, not a new guest result, syscall or action issuer.

## Exact prefix witness

The private descriptor witness binds the Files incarnation, nonreused read
incarnation, inode and an exact nonempty resident byte range. Files exposes no
removal, replacement or eviction of resident payloads, so an admitted inode
identifies the same backing throughout this Files lifetime. The witness can
resolve after OFD retirement, but does not own any lifetime itself. A pin owner
must retain the matching Files; a destroyed owner cannot resolve it.

Preparation checks actual resident length, not just offset and provisional
size. Reading through the witness creates neither an output nor a cursor
effect. Commit preflight accepts only the original live hold, not a new read of
the same bytes after abort. It consumes that hold and exclusively borrows Files
until the infallible cursor update. It is the last fallible step: the future
destination owner must finish all other admission checks before requesting it.

## Coarse retention and finite publication

One disconnected Rust root owns Files by value and retains the original
backing for all its finite destination lanes. A queue's pin retains just the
prefix witness, not another OFD reference or a pointer into storage. The root
does not reclaim individual backing or promise access after Files/Core
destruction. A Rust slice borrows the owner and precludes concurrent discard;
there is no host/ABI view or drain here.

Each lane has separately minted producer and consumer tickets. A scoped
producer borrows only the matching root and destination for admission; a
consumer can take or discard only its own lane's accepted data. Source table
retirement and closure of admission do not end consumer access. A queue
ticket binds its Files, exact registry incarnation, and lane: equal local
slots within two registries on the same Files are not interchangeable.
Files never reissues a registry identity, even after its destruction.
Lanes append within a fixed cap, with
no replacement/reuse or independent teardown in this slice. Dropping a ticket
is not host stopped-use evidence and does not reclaim a lane.

The destination reserves exact nonzero Q payload bytes and one K entry, and
prepares one R pin independently for each file prefix. Q includes reserved and
accepted bytes until cancellation, take or explicit discard. K or R can be
exhausted with byte room left.
Both record arenas reserve capacity at construction, then initialize slots on
first use. Private free lists and linked publication order avoid a scan of
either queue arena. Slot generations never wrap; saturated slots
retire. These bounds do not charge the source backing, spare allocation or the
rest of Files/Core, and do not imply a total-memory bound.

After validating current admission, both tickets, exact length and exact
source, publication links the pin into its destination and commits the source
cursor in one callback-free, allocation-free Rust turn. The existing last-OFD
cleanup can still inspect/release detached mount metadata; no constant bound on
that unrelated lookup is implied. No additional receipt
or publication serial is needed for this private FIFO. Rejection returns all
three inputs without releasing their obligations. Closing admission bars new
publication but retains accepted data. Explicit discard releases only the
queue record and its claimed credits; it proves neither delivery nor a stopped
host. Dropped tickets retain their credits while the destination is retained.

Guest-call and cancellation admission, lazy source coordination, drain
binding, captured delivery and Linux pipe algorithms remain unselected gates.
Except for the isolated diagnostic below, this owner is not installed in the
Core or Worker and creates no positive physical capability or guest result.

Before first publication, a future continuation must check both its exact
held invocation and its own open sequence in the same non-reentrant turn.
`Execution::check_held_call_live` checks only the execution half: same-image
snapshots can be reused across invocations, and an uncertain or exit-requested
execution may still own a cleanup obligation. This check neither changes that
obligation nor proves that the continuation was not cancelled. Cancellation
before first publication must not create output; after acceptance it must not
rewind input or erase the queue's ownership of accepted bytes.
The existing register first-effect gate now uses these two checks before
Domain start. The sequence belongs to the exact pending operation; an old
admission watermark alone cannot authorize any effect. This does not connect
the queue to that register operation or to any guest output path.

## Synchronous owned receiver

One internal take copies a whole head into caller-owned, pre-admitted Rust
storage. The receiver must be empty, and both its allocated capacity and an
explicit logical byte limit must cover the exact nonzero head. Refusal leaves
the queue, credits and receiver unchanged. An absent published head is not EOF:
reservations may still be live. Closing admission does not discard accepted work.

After checking the entire head and its credit update, take performs one bulk
copy and releases only that head's Q/K and any R pin in the same turn. The
receiver is independent of Files; discarding or destroying the native owner
cannot change its bytes. Inside Wasm, an owned Rust allocation still cannot
outlive the instance's linear memory. Take is neither a borrowed view nor evidence of
external delivery or a stopped host drain. No guest cursor is changed here.

## Isolated Core ownership probe

The explicit `queued-output-probe` feature puts two fixed, bounded lanes next
to the one Files owner in the actual Wasm Sealed state. Its synthetic publisher
uses a live normal execution's resident table, and only scalar byte/length
inspection or explicit diagnostic discard follows. It can check retention
after actual Rust execution resource retirement without exposing a host pointer
or claiming a real Worker producer, source-load callback or delivery receipt.
The feature implies the existing rejected synthetic probe marker. Its state and
exports are absent from both normal builds and the older sendfile-only probe.

## Ordering native owned copies and file ranges

A private writer can now snapshot a stable input loan into lane-owned storage.
It first validates admission and exact nonzero Q/K reservation, then performs
one input copy into privately allocated storage. The lane retains no spare Vec
capacity relative to the reservation and does not accept a caller's allocation.
Allocator rounding, other Files backing, and metadata remain outside Q. A
failed copy admission returns the reservation unchanged. The copied record uses
no R pin. It shares the same FIFO link, reader, and credit release as a pinned
file prefix, whose publication still copies no bytes. After a producer's pin
ticket is consumed, the record keeps only a lane-local index: queued pins
cannot be released or reused before removal of that record. Native checks publish
copied A, pinned b, and copied C in order despite reverse reservation order,
mutate the input buffers, retire the source table and producer, and read AbC
through an independent consumer.

This does not route guest writes. A real captured stream must resolve write
and sendfile through the same held destination identity, including fd aliases,
and reject operations it cannot route without bypassing that destination.
The current managed physical write and negative-only sendfile are unchanged.
The relay/session would have to retain the Core for the consumer independently
of the guest Worker. Copying into Core then into an independent host buffer
would move mutable write bytes twice; no one-copy host-write claim is made.

Worker exit proves that Worker's guest access ended. It proves neither that an
external drain stopped nor that any bytes reached a sink. Queue admission
closure, emptiness, discarded records, a stop request and a reported count
cannot replace a matching sink receipt. Unknown external effects or access
must retain their pending backing and cannot be retried. None is started by
these private operations.

## Held captured destination fence

In the private capture foundation, a Files description can carry a captured
destination instead of a physical endpoint. Only the exact matching registry
can install its producer lanes into the private stdio table; installation
rolls back the private table on failure. The two outputs use separate lanes
unless explicitly bound to the same lane. Stdin remains a physical read.

A non-copyable output hold retains the specific OFD, including through dup,
table copies and numeric FD reuse. Resolving the hold checks that live OFD
and the exact registry/lane without re-reading a current FD. The hold cannot
be resolved as a physical stream. Releasing it does not close the lane,
discard data, or prove the consumer or a host effect has stopped.

Native continuation tests cover nonzero and zero captured writes, vectored
and positioned writes, read direction, and captured sendfile. No case issues
a physical command or reserves a source/action; a separate ordinary stdio
table still issues the expected physical command. No positive guest capture,
Worker startup/alias profile, or external drain is selected by this fence.

The rejected `queued-output-probe` artifact can install these tags in a real
sealed Core startup for a raw ABI counterexample. That probe uses fixed,
independent diagnostic lanes and synthetic image/unwind receipts. It neither
publishes a captured guest write/sendfile nor runs a Worker. No startup export
for this mode exists in the normal or older sendfile-only artifact.

## Transfer pre-admitted initialized output storage

The private staging path reserves Q/K before allocating an exact initialized
buffer. The stage owns both that allocation and the exact reservation. Only
a complete stable native input copy changes the type from unfilled to filled;
initialization or a short input is not successful capture. Publication moves
the filled allocation into the same FIFO, without a second copy; cancellation
returns the exact reservation and releases storage. Failed allocation rolls
back its reservation. Foreign or closed publication returns ownership intact.
No new buffer view crosses an ABI, callback, or async boundary.

Initialization costs a zeroing pass, followed by one input copy. Moving into
the FIFO performs fixed metadata work regardless of payload size; direct
native copy remains available without an initialization pass. A future
Worker bridge still needs exact invocation/sequence/cancel admission and
trusted lexical transfer evidence; it cannot publish merely initialized bytes.
External consumers need their own offer identity, ended access and stopped
effects. Neither all confirmed bytes, queue acceptance, nor an observed
Worker exit establishes any external delivery or stop.

## Exact private captured-write handoff

The native call owner binds the current invocation and retained execution
snapshot, captured request sequence, one Domain span, one captured OFD, and
the initialized Q/K stage. Start checks the exact owner and open reservation,
consumes the span once, and gives the trusted native caller a short copy
guard. Only an exact slice copy through that guard proves native fill; an
initialized buffer, byte count, or a dropped guard alone does not.

End of access to the guest source and the Core stage are both necessary.
Unproved or one-sided access keeps the provisional backing and owners
alive. Once access is uncertain, publication is permanently disabled. An
exact later proof that both accesses ended may discard unpublished storage
after cancel or producer exit. It is not a sink-stop receipt. Successful
capture also requires a still-live call at acceptance, and late exit cannot
undo an accepted record. Publication rejection after a settled copy is an
explicit terminal result, distinct from an invalid receipt.

This native owner neither exposes a raw view nor admits a guest syscall. Its
caller must still bind the trusted input slice to the admitted source and
enforce sequence admission; a future raw relay needs a separately guarded
lexical interval. No Worker or external consumer is connected by this step.
