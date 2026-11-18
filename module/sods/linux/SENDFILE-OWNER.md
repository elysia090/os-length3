# Canonical-source transfer protocol, physical capability still absent

`src/sendfile.rs` is retained by the syscall Continuation and private Linux ABI7.
The real Node Worker caller now completes a **negative capability subround** and
stops as Unsupported40, without source dispatch, physical output or a fabricated
zero return. There is no accepted production physical capability yet. Ordinary
cat still does not succeed; default Kernel, browser and terminal selection are
unchanged. Synthetic native/raw-Wasm evidence is separate from physical output.

## Selected contract and authority

The selected Rust admission accepts a NULL offset and a readonly regular input OFD
to an exact held HostStream Write description. FD arguments use the low32-bit
Linux int representation; original full-u64 arguments remain captured. Count is
clipped to MAX_RW_COUNT0x7ffff000. Explicit offset pointers, mutable input/output,
generic guest mappings and signals require other contracts, not a hidden TS
fallback or invented ENOSYS.

One `Sendfile` owns one call, not a second unbounded operation arena. Before a
capability or source service may start it captures both descriptor holders,
Files incarnation, execution snapshot, invocation, request sequence, original
arguments and one Domain non-byte Effect. That Effect uses the same sole issuer
and finite arena as spans and changes. Its units bound the clipped request;
receipts separately check the smaller actual offered length. No guest span,
guest scratch buffer or completion-time FD lookup is introduced.

This component alone holds and finishes the pending call. Continuation retains
one optional owner and the non-Copy capability request; it does not duplicate
call ownership or drop unfinished work. Common busy/owns/abandon/retirement checks
include that owner. Request sequences are bounded to1..i32MAX and consumed
monotonically at the sequenced admission, including capacity/Unsupported results.
Unsequenced diagnostics never admit sendfile or consume a Worker sequence.

## Capability before payload

The stages are CapReady, CapChecking, LoadingReady/Loading, OfferReady,
Started/Unknown, Closing and Terminal. The read-only capability request binds
the exact captured endpoint, owner, sequence and action. It neither grants an
output offer nor exposes source bytes. A rejected request closes this operation
as Unsupported40 without starting a source attempt.

There is deliberately no production constructor for an accepted capability
receipt yet. The production host retains the exact request metadata and settles
rejection once, with no qualifier, source callback or output call. Acceptance is
synthetic only in unit tests or an explicit `sendfile-probe` feature artifact.
Those tests do not certify socket kind/flags/lifetime, native behavior or
sendfile/write equivalence. An application boolean cannot fill that boundary.

Even count0 and source EOF require destination qualification. Native Linux
observations show that full/broken FIFOs can fail at zero/EOF, so a generic
endpoint-independent Return0 shortcut is invalid. Count0 does not load a source.
For a nonzero request, the existing Store may need to materialize the source
before it can establish EOF; provisional metadata is not substituted for exact
source state. A matching cancelled/lost load settles without adopting bytes;
stale or foreign load evidence retains both holders and the supplied input.

Closing and reusing both numeric FDs during a delayed service cannot retarget
the operation. Its held original source cursor and output endpoint survive;
replacement descriptions are untouched. A duplicate of the old source OFD
observes exactly the one committed prefix.

## One offer, independent view and prefix evidence

One exact start consumes effect permission and installs the lexical core-view
guard before retrieving the canonical source address. The eventual host must
construct a fresh built-in view and synchronously prepare/write/submit a matching
receipt without callbacks, awaits or allocating Core exports in between.

Unknown cumulative progress closes admission and retains the source cursor,
destination, call and effect. Even an all-confirmed Unknown is not stopped.
An independent trusted access-ended certificate can end the lexical view while
leaving the prefix/effect uncertain; a prefix alone cannot end that view. Invalid
owner/sequence/action, decreasing/excess counts or contradictory error evidence
are rejected before guard or Domain mutation.

Stopped evidence includes both ended access and no further effect beyond the
confirmed prefix. It commits the held OFD once, including a late prefix after
cancellation or guest fault. A closed/lost guest never receives a resurrected
successful return. A short positive result is not retransmitted internally.
Physical write errors known to have stopped at zero settle ownership but close
transport; this initial component does not relabel write errno as proved Linux
sendfile errno or emulate SIGPIPE. Preparation failure is also a transport
failure, not fabricated guest error evidence.

Ready cancellation can release. Dispatched capability/load work retains its
holders until matching stopped service evidence; after output starts, cancelling
or observing guest exit cannot abort the source read and roll its cursor back.
Cleanup errors keep their tickets and require explicit cleanup retry. Terminal
means all this operation's holders/action/call are gone, not that other owners,
the Worker or the entire domain have retired.

Before any external dispatch, a fully rolled-back admission error is distinct:
the component reports AdmissionFailed without closing guest admission. The
Continuation maps returned Files BadFd/allocation errors through the existing
explicit errno policy and unsupported kinds to Unsupported40. Domain capacity,
Busy, identity and protocol errors are not relabelled as guest errno. An incomplete rollback remains closed and retained, not a successful
ordinary error return.


## Private ABI7 and segregated probes

ABI7 keeps earlier tags0..9 and adds Cap10, Load11 and Offer12. Each carries the
same action and original Worker sequence; Cap/Offer carry the held endpoint and
Offer its actual available length. One cap_start stores the non-Copy request
before metadata is published. cap_finish compares exact owner/sequence/action/
endpoint and result shape before consuming that ticket. Production proof0 means
rejected; proof1 is available only in the synthetic feature build. No stage
relooks up a guest FD or assigns a new transport request sequence.

Load start/finish compare both SourceId and attempt, with the existing bounded
source staging Vec; source staging is not a guest payload buffer. Start publishes
the canonical pointer only after ownership/effect/view admission. Receipt encodes
cumulative prefix, outcome and separate access-ended evidence. Known stopped
outcomes require ended access. All shape/prefix/identity checks and Domain receipt
succeed before Unknown+Ended can clear the lexical guard. Cleanup retry needs no
action already retired; a metadata query neither starts nor completes an offer.

The global guard is `SendFinish{execution, sequence, action}` and runs before the
older broad read-view exception. It rejects every unrelated allocating/state
export, including a genuine other owner's late receipt, and excludes new send
exports during existing path/read views. Generic action start/cancel/receipt/
retire cannot bypass the retained Continuation owner after lexical access ends.
Result scalars and constant ABI/probe marker observations do not allocate. Reinit
remains refused once initialized. Late stopped prefix still cannot revive a
closed or lost guest, and retirement cannot drop its unfinished owner/request.

`cargo build --features sendfile-probe` creates a conspicuously marked diagnostic
artifact. Its `linux_sendfile_probe` sentinel and independent synthetic lexical-
end export are absent from a normal build. The production memoryHost rejects
probe names **before instantiation**, even with correct shape/version or a
trapping start section. Positive raw tests receive this artifact explicitly via
`SODS_SENDFILE_PROBE_WASM`; normal tests use `SODS_LINUX_WASM`. These are no new
runtime dependencies, artifact downloads or public facade hooks. Old ABI6
modules fail even if all new export names are supplied. Shape is not provenance;
private raw receipt flags still require a trusted embedding, not hostile-host
security. The seven-method managedRoot facade exposes none of these raw calls.

Native and raw-Wasm tests cover exact finite owners, valid issued foreign actions,
source cancellation/staging, all-export view exclusion, malformed combined
receipts, Unknown/late prefix and no guest revival. They use synthetic capability/
output/stop evidence. Actual negative Worker tests do not substitute it for real
output, and a positive fake runner is not accepted as current-caller evidence.

## Necessary work and remaining integration

An accepted physical prefix P must reach the output boundary. A cold compressed
source also requires exact payload acquisition and decoding demanded by the
current whole-source Store interface; whole-file materialization is an interface
cost, not a universal decoding lower bound. The syscall needs no extra N-byte
guest copy or JS snapshot. A view object, bounded state/receipts and Worker
synchronization are still real work. The eventual Node write path is not Linux
zero-copy sendfile, and a native/Wasm static instruction ratio is not a dynamic
speed ratio.

The current global view check scans the bounded execution table, and Domain
operations retain their bounded arena/binding searches. These are implementation
costs, not required theoretical minima. Likewise the three-stage negative
subround is chosen to validate future-positive ownership: a backend known at
startup to reject all source output could reject immediately under a different
capability/error-ordering contract. This stage does not optimize that different
profile or infer positive transfer performance from a zero-output measurement.

The actual accepted physical capability, positive host source/output transport
and successful ordinary-cat closure remain absent. Exact ABI view/ownership
checks are connected and tested with synthetic raw evidence; real Worker
negative-capability rejection and retirement are tested separately. Positive
source-await/lost-output behavior cannot be claimed from the negative path.
General non-TTY stdio and WASI filetype labels are not socket family/type proof. A proc-based candidate has restrictive framing/namespace
conditions; a new native host artifact would add ABI, platform, distribution and
lifetime obligations and is not assumed or silently installed here.

Required next evidence includes real physical short/Unknown/lost-return cases
and actual current-core/Worker ordinary cat
with authenticated identical input bytes, stdout/status, source-load counts,
independent Worker stop/resource retirement and a fresh next run. Strict types,
package/runtime CI and new-head browser6MB remain independent gates. Synthetic
owner tests do not establish any of them.
