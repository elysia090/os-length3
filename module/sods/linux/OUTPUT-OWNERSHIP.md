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

The disconnected Rust destination owns Files by value. Its pin registry
retains just the prefix witness, not another reference to the OFD or a pointer
into storage. The queue keeps the original backing alive by retaining the
whole Files owner. It does not reclaim an individual backing, or promise access
after Files/Core destruction. A Rust slice borrows the owner and precludes
concurrent discard; there is no host/ABI view, drain or separate receiver here.

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
