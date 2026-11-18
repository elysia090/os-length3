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
ticket binds both its Files and lane incarnation: equal local pin/entry slots
in two queues are not interchangeable. Lanes append within a fixed cap, with
no replacement/reuse or independent teardown in this slice. Dropping a ticket
is not host stopped-use evidence and does not reclaim a lane.

The destination reserves exact nonzero Q payload bytes and one K entry, and
prepares one R pin independently. Q includes reserved and accepted bytes until
cancellation or explicit discard. K or R can be exhausted with byte room left.
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
This owner is not installed in the Core or Worker and creates no positive
physical capability, guest result or new ABI.

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
copy and releases only that head's Q/K/R in the same turn. The receiver is
independent of Files; discarding or destroying the native owner cannot change
its bytes. Inside Wasm, an owned Rust allocation still cannot outlive the
instance's linear memory. Take is neither a borrowed view nor evidence of
external delivery or a stopped host drain. No guest cursor is changed here.
