# Non-byte effect admission foundation

This internal domain primitive is a lifetime reservation, not a syscall, a
physical register command, arbitrary host authority or a new public runtime API.
It is not connected to a guest caller by this change. The actual BusyBox TLS and
owned-source transfer coordinators remain separate gates.

## One issuer, one bounded arena

A Domain has exactly one unique incarnation, one Issuer and one finite action
arena. Span, lifetime Change and non-byte Effect use that same arena and token
sequence. Token sequence0 is valid. Exhaustion is not wrapping/reuse, and no
second Issuer is constructed under the same domain identity.

An Effect retains an exact binding incarnation independently of byte spans. It
can count operation-specific units, including1 register application or a bounded
number of output bytes. Its units are not guest offsets or ranges and are not
clipped to the Memory extent. It grants no guest byte access. A future canonical
source-output coordinator must separately own its source view and both OFDs;
this reservation cannot substitute for those owners.

Effects may coexist with a RunHold and spans. They cannot be admitted while a
binding is Changing. A Change requires no running guest, spans or Effects, so
unwinding a guest does not accidentally release an Unknown physical operation.
Zero-unit Effects still have an actual lifetime and finite slot; they are not
fake `span(binding,0,0)` capabilities.

## Evidence and retirement

Ready cancellation makes only that reservation reclaimable. Start consumes
permission before physical dispatch; duplicate/reentrant starts never retry an
uncertain operation. A receipt reports cumulative confirmed units plus Stopped
or Unknown. Stopped certifies both the stated effect prefix and ended access;
Unknown certifies neither the remainder nor ended access. Cancellation after
start is not a receipt. Matching monotone late Stopped evidence may finish the
operation once; stale, foreign, decreasing or excess receipts cannot free it.
Retirement of a terminal Effect releases its retained binding obligation and
slot, not the binding or unrelated owners themselves.

The generic foundation has no TargetDestroyed/Discarded transition. Until an
operation-specific contract proves such a terminal condition, Unknown remains
quarantined. In particular, observed Worker exit is not evidence that an FS
setter was never applied. It cannot be converted into fabricated confirmed0
Stopped evidence. Likewise guest stop says nothing about a still-active external
stream/source callback. A future register-specific destruction proof must not
silently generalize to output IO.

## Next TLS boundary, separate from this foundation

The later selected integration is documented in [TLS-CALLER.md](TLS-CALLER.md).
This foundation alone does not supply that transport or Linux caller.

Rust must own ARCH_SET_FS admission, exact requested value, invocation/request
sequence, action and private completion. FS base is not a dereferenced pointer;
Memory span/range validation cannot decide this operation. The selected low-address
fixed-memory profile and any unsupported high-address/other arch_prctl cases must
be explicit, not guessed Linux errno or a fallback into the TS Kernel.

The actual instance lives in `runtime/host/node/guest.ts`. Its syscall import is
blocked in Atomics.wait, so a normal Worker message handler cannot apply a register
while it waits. A dedicated shared-channel subround must grant one application,
apply a captured built-in Global setter to that instance.exports.fs, acknowledge
exact invocation/sequence/action, then wait for Rust's final decision. Success
cannot return to the guest before Rust accepts matching applied-and-stopped
receipt. A main-realm Instance/Global or metadata-only decision is not equivalent.

The parent must settle the subround promise even on actual Worker exit, never
replay an Unknown application, and distinguish stop request, observed exit,
physical register obligation, pending request and resource retirement. Either
retain Unknown conservatively or add an explicitly reviewed register-only
TargetDestroyed terminal state without claiming successful application or zero.

Required integration counterexamples include actual `%fs:0` sentinel reads after
two valid updates, foreign/stale/duplicate commands and receipts, applied-ack loss,
final-return loss, missing/wrong/immutable fs exports, cancellation and Unknown
retention through actual stop. open(2), guest TID/clear-tid, exit_group and sendfile
are not implemented by this foundation.
