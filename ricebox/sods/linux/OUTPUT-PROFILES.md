# Linux output profiles and ownership

The managed Linux host separates syscall policy from physical transport.
Rust owns the guest's descriptors, cursor updates, request ordering,
admission limits, and receipts. The host owns the Worker, engine memory,
source transport, and operating-system resources. A result from one output
profile is not evidence of success in another.

## Choose the output contract

| Profile | Output contract | Selection and scope |
| --- | --- | --- |
| Borrowed stdio | A guest write returns the observed result of a synchronous operation on the inherited standard descriptor. | The existing Node `--managed` CLI. It does not qualify inherited outputs for sendfile. |
| Captured result | A successful guest call publishes labelled bytes into a bounded FIFO. The application separately takes an owned result. | The explicit `capturedResultHost` entry in [sods/linux](../runtime/linux.ts), with a trusted `capture-result-v1` artifact. Linux x86-64, Node 22 or 24. |
| Owned stdout | A guest write or qualifying sendfile uses one exclusive file and returns a confirmed prefix before the next guest call. | The private `runOwnedStdoutProgram` and `runOwnedStdoutRoot` [Node entry points](../runtime/host/node/run.ts), with a trusted `owned-stdout-v1` artifact. Linux, Node 22 or 24; tested on an x86-64 host with static x86-64 guests. |

None of these profiles replaces the default Linux caller or the browser
`RemoteKernel` console. The managed profiles support selected syscalls,
not a general Linux VM. TTY, signal, arbitrary mappings, fork, sockets,
and inherited nonregular sendfile endpoints require separate contracts.
Unknown artifacts do not fall back to an ordinary profile.

`capture-v1` alone verifies a capture identity but cannot start an execution.
`capture-result-v1` adds the bounded result profile (ABI 7, result wire 6).
Synthetic probe artifacts are separate test builds and are rejected before
instantiation by normal admission. The owned-output artifact cannot be built
with a capture or probe feature.

## What a receipt proves

The continuation binds each syscall to its execution, invocation, Worker
sequence, and action. If an operation refers to an open file description
(OFD), it holds the original description rather than looking up the numeric
descriptor again after an asynchronous wait. Reusing a descriptor number
cannot redirect a pending operation. Only the exact action can settle it.

Keep these observations separate:

- **Accepted:** the guest's bytes belong to the captured FIFO.
- **Taken:** the application owns a copy and the exact head has been consumed.
- **Transferred:** a physical sink reports a known prefix for its exact offer.
- **Stopped:** the relevant access has ended and no further effects can occur
  for that operation.

A stop request is not observed Worker exit. Worker exit does not end an
external sink's access or retract records already accepted from the guest.
A full count with unknown access is not a completed receipt. Unknown effects
retain their owners; they are not retried, turned into a zero result, or
discarded to recover capacity.

## Captured results

The session keeps one FIFO and one independent receiver across producer
retirement. Stdout and stderr share that FIFO, but each record keeps the
stream of its original OFD. Closing or reusing a guest descriptor does not
change the label. Capture does not acquire physical stdout or stderr.

The trusted caller provides the following limits before a Worker starts:

| Limit | Meaning |
| --- | --- |
| `maximumRequest` (M) | Largest indivisible write or send accepted by this profile. |
| `queueBytes` (Q) | Total retained bytes, including pinned ranges. |
| K = 3 | Retained FIFO records. |
| R = 1 | Retained immutable source ranges. |

The admission envelope is `1 <= M <= Q <= 65536` bytes. This is not a maximum
Linux write size or a measurement of total process memory. A larger request
is not silently split or turned into a short write. Ordinary stream input is
absent unless the trusted caller chooses `borrowStdin: true`; that explicitly
borrows the Linux non-TTY fd 0 without permission to use fd 1 or fd 2.

A write copies its paused guest-memory range into Core-owned storage. A
qualifying sendfile pins an immutable, already resident source range, links
it to the FIFO, and advances the original input cursor in one Rust turn.
A canonical file made resident by a previous read qualifies; a cold or
already loading file is refused without starting or disturbing its loader.
An observational readiness check does not reserve a read or change a cursor.

A non-draining run refuses when capacity is exhausted. The paced entry,
`runPathPaced`, can instead suspend one original request on recoverable
pressure. The held invocation, sequence and action identify the resume;
the guest does not resend a syscall or look up its FD again. The blocked
request does not consume queue credit or expose a view. Only an exact
consumer receipt releases the applicable byte, record, or pin credit.
Cancellation releases unstarted work without advancing its cursor or
discarding accepted records. A stop request wins over a simultaneous wake.

`waitForCapturePressure` reports a suspended producer, and
`waitForCaptureOutput` reports an available record. Neither delivers bytes,
claims EOF, or certifies exit. `takeOutput` returns an independent
`{stream, bytes}` result only after a successful matching copy receipt.
It revalidates the exact head and its length, then copies into a final
allocation during one exclusive lexical view. No callback, await, memory
growth, or unrelated Core operation is permitted during that view.
A stale receipt cannot unlock a newer attempt. A peek, empty FIFO, or
unpublished copy does not consume a record.

### An external sink needs its own lifecycle

Taking a captured record does not report an operating-system result to the
guest. An asynchronous sink must receive independent storage before it can
start; it cannot retain a view into Core. Once Rust has acknowledged a
captured write, a later disk, pipe, or terminal error cannot change the
guest's result.

A bounded sink test retains one head's FIFO charge until the sink's own
offer settles. Its progress is a cumulative position within that head, not
a delta or an operating-system file offset. A stopped short result retains
the untouched suffix; another offer needs a new action and does not replay
the confirmed prefix. An unresolved effect prevents overtaking, credit
release and handle reuse. This sink test does not add a selected physical
sink to the captured-result host.

For queue and source-range details, see
[Output ownership](OUTPUT-OWNERSHIP.md).

## Synchronous owned stdout

The owned profile validates an independent byte-length and digest pin,
Wasm role, export surface, and initialization before creating an output.
It exclusively creates a new, non-append regular file. It does not use an
existing file or follow an existing symlink at the output path. Only guest
stdout (fd 1) is installed; neither fd 0 nor fd 2 is borrowed. A guest
failure after creation may leave an empty output file.

The startup capability identifies the selected Files incarnation, OFD
slot, and generation. Rust compares it with the destination already held
by the original Sendfile request. An inherited descriptor with the same
endpoint number cannot qualify. No application boolean or guest-supplied
host FD grants permission to transfer bytes. The capability is checked
inside the sequenced syscall; this artifact has no host capability
start/finish round trip.

A qualifying call reads from a readonly canonical regular source at its
current OFD offset. The adapter synchronously borrows the offered Core view
for the exact Node write, then supplies one matching prefix/access receipt.
A positive result advances only the confirmed input prefix. One Node API
call need not be one kernel syscall. A reported count is not an fsync,
terminal flush, or peer delivery guarantee. Unsupported physical results
do not become invented sendfile errno values.

The Node adapter retains at most one active or unresolved native owner.
Observed Worker exit, request settlement, and Rust retirement are required
before closing a File used by a running guest. For example, with a one-byte
file-size limit, the first write remains on disk and an unclassified EFBIG
on the next effect retains the same File and Core. The adapter cannot
replay that effect, switch to inherited stdout, or allocate a second owner.

### Prepared roots and cold sources

`runOwnedStdoutProgram` builds a resident rootless program. The prepared-root
entry uses the same output and Worker owner, while keeping image startup
separate from canonical source loading. A selected AOT image can start
without reading the underlying ELF. A cold sendfile later requests the
exact source and attempt on that same original syscall.

The sealed root supplies the stored range and decoded size. A trusted
transport authenticates and decodes the selected root's data; matching a
length alone is not content authentication. No Core view or output effect
starts during the asynchronous wait. The host checks the unshared byte
type and exact size, stages directly in Core, and settles the matching
source attempt once. A load receipt is not an output receipt. A stop request
blocks both adoption if the source has not arrived and physical dispatch
after an offer is formed but before transfer. Observed exit and resource
retirement are still separate requirements.

See the [prepared-root contract](ROOT-AOT.md) and the
[Sendfile owner](SENDFILE-OWNER.md) for identity, cursor, and cleanup rules.

## Artifact and distribution trust

A host needs the selected bytes and an independent trusted pin. A matching
export list does not authenticate a module, and a digest supplied by the
byte provider is not its own authorization.

The optional Ricebox capture-result role is bound to the independently
selected index digest and length. The
[distribution reader](../../distribution/deployment/capture-result.ts) checks
the content-addressed stored blob and bounds expansion before passing the
expanded digest, size, and role to Sods. The host hashes and compiles the
same owned byte snapshot. An ordinary build may omit the optional artifact;
the default release build does not select it.

The owned-output profile uses a separate role and is not selected by a
deployed index here. An eventual distribution caller must choose its root
wire, source transport, and owned-output artifact from the same verified
generation. A wrong role or host, missing descriptor, mixed generation, or
bad stored/expanded bytes must fail before file creation. Do not route a
failed admission to a different output profile.

## Compatibility and validation

- The inherited CLI retains separate stdin, stdout, and stderr. Linux tests
  exercise a full nonblocking pipe, a short accepted prefix, a closed peer,
  and append stdout. A borrowed write succeeding on an append file does
  not qualify that file for sendfile, which can reject even a zero request.
  The managed CLI's EPIPE result is not native default SIGPIPE behavior.
- The selected capture tests cover pressure, output ordering and labels,
  retained results after stop, and ready-only source acceptance. Controlled
  requests of 5, 32, and 4096 bytes are compatibility examples, not a
  workload distribution or a fixed recommendation for M or Q.
- The real Node Worker owned-output tests check sequential writes around
  sendfile and continued reads from the original input cursor. The cold
  prepared-root test observes one source callback, none at AOT startup,
  and no subsequent reload. A bad or stopped source leaves only the first
  write. Mutating the provider's buffer after staging changes neither the
  output nor the source cursor result.
- A browser migration must preserve labelled batches, flush epochs,
  backpressure, and the final byte boundary, independently of producer
  retirement. Browser termination and a drained UI queue do not supply
  the Node exit receipt. Workerd shared Wasm memory alone does not provide
  the Worker capabilities this host requires. The portable Worker and
  Workerd execution paths are not validated by the Node tests.

The [CI workflow](../../../.github/workflows/ci.yml) builds distinct Wasm
roles and tests them with the current translator. Its Node tests do not
stand in for browser or deployed Workerd tests. See
[managed-owned-stdout.test.ts](../test/runtime/managed-owned-stdout.test.ts),
[managed-sendfile-abi.test.ts](../test/runtime/managed-sendfile-abi.test.ts),
and the [distribution tests](../../distribution/deployment/test/capture-result.test.ts)
for the respective assertions.

Do not remove a TypeScript implementation while a supported entry point
still calls it. Before moving the existing CLI or `RemoteKernel`, check
imports, Worker URLs, package exports, and supported hosts. For Remote,
prove multiprocess behavior, input readiness, signals, flush, and retirement.
The live `cpu.ts`, `channel.ts`, `worker-stop.ts`, `remote.ts`,
`sys-file.ts`, and `fd.ts` are not replaced by either output profile.

## Work bounds and measurements

These are bounds for the stated ownership contracts, not general instruction
or latency bounds:

| Operation | Payload work at the current boundary |
| --- | --- |
| Captured guest-memory write taken by the application | One guest-to-Core copy and one Core-to-owned-result copy. |
| Captured resident sendfile taken by the application | A Core pin and one Core-to-owned-result copy; no staged guest payload. |
| Synchronous owned resident sendfile | No additional owned payload copy. A positive transfer needs a physical effect and its exact result. |
| Cold owned sendfile under the whole-file source contract | One N-byte copy into Core for the whole decoded source, then the same resident offer. An authenticated range contract could have a different bound. |

The wasm32 measurements keep the Sendfile owner at 432 bytes and the
global state at 1312 bytes. An owned output token adds 32 bytes to the
slot (1752 to 1784) for that artifact. On Node 22 x64 Liftoff, the
sequenced ingress export is 412 instruction bytes in both builds. The
owned build's internal dispatcher is 2628 bytes versus 2140 in the
ordinary build, with a 1264-byte installed-qualification helper. These
are static instruction sizes, not numbers of executed instructions.

For one resident-byte transfer through an actual Worker, an end-to-end
fixture used 3 warmups and 16 observations per Node version. Medians were
108.3 ms on Node 22 and 108.7 ms on Node 24 in the measured environment.
That includes artifact checking, Core startup, ELF translation, Worker
startup, I/O, and retirement. It is not a per-byte benchmark or evidence
of a speedup.
