# Sendfile ownership and completion

The Linux core owns the syscall, source cursor and exact output description.
Ordinary managed stdio rejects this capability before loading source bytes.
The explicit owned-stdout profile accepts it only for its pinned, invocation-owned
file endpoint; captured output publishes to its selected logical lane instead.
Neither profile establishes generic sendfile, socket or terminal compatibility.
See [output profiles](OUTPUT-PROFILES.md) for selection and host support.

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

An accepted owned-file receipt comes from the qualified Node host for the
exact open file description held by this invocation. The ordinary host retains
the request metadata and settles rejection without a source callback or output
call. The raw probe validates state transitions but is not trusted as a runtime
artifact. Endpoint-kind labels and an application boolean are not receipts.

Even count0 and source EOF require destination qualification. Native Linux
observations show that full/broken FIFOs can fail at zero/EOF, so a generic
endpoint-independent Return0 shortcut is invalid. Count0 does not load a source.
For a nonzero request, the existing Store may need to materialize the source
before it can establish EOF; provisional metadata is not substituted for exact
source state. A matching cancelled/lost load settles without adopting bytes;
stale or foreign load evidence retains both holders and the supplied input.
Starting capability/source work, accepting a loader's bytes and starting the
first offer require the current exact held invocation in addition to the
operation's matching identity and open state. A Running image with exit already
requested does not qualify. Matching stopped evidence still settles the original
operation and is not gated by permission to start another effect.

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
cancellation or guest fault. A closed/lost or exit-requested invocation does
not receive successful return even when the stopped effect and cursor commit
are known. A short positive result is not retransmitted internally.
Known stopped zero with a **nonempty offered source** still settles the physical
prefix0 and releases the operation once, but closes as TransportFailed rather
than returning a guessed EOF to the guest. Only qualified offered0 (count0 or
actual captured EOF) admits Return0. A native write0 alone does not prove Linux
sendfile0 equivalence. This deliberately narrow first profile does not claim
that non-EOF zero is impossible in general Linux splice/sendfile paths.
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

Unresolved physical output is not retried: the host retains the file and core
until their work is known to have stopped. Node tests for the explicit owned
profile cover a physical append, an unresolved write failure and a fresh run.
A fixed-file capability does not establish generic physical sendfile, shared
stdio, POSIX pipe/socket behavior, or terminal support. Raw owner tests are
separate from end-to-end execution and browser measurements.
