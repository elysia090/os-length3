# Canonical-source transfer owner, not a connected sendfile caller

`src/sendfile.rs` is an internal ownership component with synthetic native unit
tests. It is **not connected** to the syscall continuation, Wasm ABI, Node host or
Worker. The current selected caller still reports sendfile(40) as Unsupported.
This component alone does not make ordinary cat succeed or move the default
Kernel, browser or terminal onto the managed caller. Linux ABI6 is unchanged.

## Selected contract and authority

The proposed first caller admits a NULL offset and a readonly regular input OFD
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

This component alone holds and finishes the pending call. A future containing
Continuation must not duplicate that ownership, drop an unfinished component or
let generic action exports bypass it. Request sequences are locally bounded to
1..i32MAX; the containing sequenced caller remains responsible for monotone
admission and no transport replay.

## Capability before payload

The stages are CapReady, CapChecking, LoadingReady/Loading, OfferReady,
Started/Unknown, Closing and Terminal. The read-only capability request binds
the exact captured endpoint, owner, sequence and action. It neither grants an
output offer nor exposes source bytes. A rejected request closes this operation
as Unsupported40 without starting a source attempt.

There is deliberately no production constructor for an accepted capability
receipt or lexical AccessEnded certificate yet. Unit tests construct synthetic
receipts inside the test module. Those tests do not certify actual socket kind,
flags, lifetime, Node native behavior or sendfile/write equivalence. A supplied
application boolean cannot fill this missing physical boundary.

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
future caller maps the returned typed error using its explicit errno/Unsupported
policy. An incomplete rollback remains closed and retained, not a successful
ordinary error return.

## Necessary work and remaining integration

An accepted physical prefix P must reach the output boundary. A cold compressed
source also requires exact payload acquisition and decoding demanded by the
current whole-source Store interface; whole-file materialization is an interface
cost, not a universal decoding lower bound. The syscall needs no extra N-byte
guest copy or JS snapshot. A view object, bounded state/receipts and Worker
synchronization are still real work. The eventual Node write path is not Linux
zero-copy sendfile, and a native/Wasm static instruction ratio is not a dynamic
speed ratio.

The actual physical capability, exact owner/action-specific global ABI view
guard, thin host transport, source-service cancellation and real Worker closure
remain unconnected. General non-TTY stdio and WASI filetype labels are not socket
family/type proof. A proc-based candidate has restrictive framing/namespace
conditions; a new native host artifact would add ABI, platform, distribution and
lifetime obligations and is not assumed or silently installed here.

Required next evidence includes raw ABI guard/foreign receipts using valid IDs,
real short/Unknown/lost-return cases, and actual current-core/Worker ordinary cat
with authenticated identical input bytes, stdout/status, source-load counts,
independent Worker stop/resource retirement and a fresh next run. Strict types,
package/runtime CI and new-head browser6MB remain independent gates. Synthetic
owner tests do not establish any of them.
