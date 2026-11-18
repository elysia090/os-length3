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

The range-pin/finite queue connection is a separate next slice. Pin preparation
must not commit the source cursor or create output. Only publication of its exact
held source prefix into a real owned destination may do that. Public delivery,
consumer/drain binding and Linux pipe algorithms remain unselected gates; no
test-only physical success can substitute for them.
