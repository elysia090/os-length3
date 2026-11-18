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

The range-pin/finite queue connection is a separate next slice. Pin preparation
must not commit the source cursor or create output. Only publication of its exact
held source prefix into a real owned destination may do that. Public delivery,
consumer/drain binding and Linux pipe algorithms remain unselected gates; no
test-only physical success can substitute for them.
