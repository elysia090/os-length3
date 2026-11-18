# Read-only openat caller slice

The original stage below is preserved; the later open(2) normalization section
extends the same owner without changing its readonly proof domain.

## Purpose and proof domain

Extend the existing opt-in Node `--managed` caller by one complete route:
**guest openat -> a Rust-owned open description -> read -> close**. The first
actual caller opens its own executable named by argv[0], reads its ELF header,
closes it and exits. The CLI already owns that canonical inode, so this needs no
new root-import API or test-only public launcher.

This is not production ricebox/browser migration, ordinary-shell compatibility,
a writable filesystem or a replacement Linux VM. The default TS runtime remains
unchanged. The managed profile is one paused guest, fixed private engine-memory
ownership (physically shared with its Node Worker), one syscall at a time, sealed
prepared regular files/directories and mode-only credentials. Its physical
linear-memory bounds do not represent guest virtual mapping holes/permissions.
A NULL pathname pointer is rejected; positive regular/stream I/O still uses
physical linear offsets, so this does not establish arbitrary Linux EFAULT
equivalence.
Logical guest mapping authority is a separate required cutover before claiming
ordinary process-memory compatibility.

## Owners

- Rust execution owns invocation/image/binding admission and the pending call.
- Rust Files/FsContext/mounts own namespace, path starting points, inode identity,
  mode checks, open descriptions, slots, offsets and place/source holds.
- Rust committed execution credentials own search and final-read decisions.
- The host owns actual Memory/Worker objects and short intrinsic view/copy work.
  It does not choose an inode, resolve a path, authorize flags or return its own
  Linux errno. The existing Node stdio adapter still owns physical stream calls.
  These are reviewed private-host contracts, not a JavaScript compartment or
  sandbox against arbitrary same-realm host manipulation or false receipts.

## Admitted syscall subset

Add x86-64 openat (257) and close (3) beside the existing read, host-stream write
and exit route. This does not add open(2), O_PATH, create/truncate/write access,
mutable status flags, mmap, signals or multiple guest runners.

Open flags are decoded as the ABI's low 32-bit int. Admit read-only access with
O_CLOEXEC, O_DIRECTORY and O_NOFOLLOW. O_NOCTTY and the explicit x86-64
O_LARGEFILE bit are admitted no-ops for these regular/directory kinds. Other
flags remain an explicitly unsupported managed profile, not a fabricated Linux
errno or a silent downgrade. CLOEXEC belongs to the new slot.

The managed CLI's existing three stdio slots currently exhaust its limit. Give
this explicit finite profile 64 slots/descriptions/FD positions, two FsContext
records and 71 mount holds. Sparse records allocate as needed; these logical
limits are not exact heap ceilings. The 71-hold budget includes the bootstrap
root ticket, live Fs root/cwd, executable, up to 64 independently opened file
positions, the temporary copied Fs root/cwd and a captured dirfd position. Per-table FD exhaustion is distinguished
from allocation/domain-capacity failure before FD publication.

## One operation, including input and path bases

1. Validate the active execution/invocation and same memory binding. Decode
   supported flags before issuing host work. Bad/null/out-of-extent pointers
   return EFAULT within this fixed-memory profile.
2. Before capture, acquire an independent FsContext snapshot (held root and cwd),
   copy the committed fixed-field credentials, and capture the dirfd candidate.
   Candidate states are an exact held directory Place, BadFd, NotDirectory or
   admission failure. It must never be looked up again by reusable FD number.
   AT_FDCWD uses the captured cwd. An absolute path ignores the candidate,
   including its failure, and releases any unnecessary hold.
3. Rust reserves a span of at most min(4096, physical extent - pointer), retains
   the invocation and owns initialized scratch. Scratch is allocated lazily,
   bounded by 4096 bytes, and reused; it is not initialized afresh per short path.
4. A one-shot start grants the host a core scratch view. Captured intrinsic
   indexOf/set may find the first NUL and copy only that prefix. This is physical
   marshaling, not path semantics. No callback, await or core call occurs between
   fresh view construction and the copy. No view escapes. Capturing a
   TypedArray.subarray method is insufficient: it still invokes SpeciesConstructor
   and may expose the buffer to a callback. Use fresh captured built-in constructors
   on held buffers, not species-sensitive view creation. See the
   [ECMAScript TypedArray specification](https://tc39.es/ecma262/2024/multipage/indexed-collections.html).
5. A matching receipt reports actual copied count and independent stopped/unknown
   evidence. Rust validates count against the admitted span and inspects only
   scratch[..actual], never stale tail. An actual count of zero (even for an empty path), or a short capture without
   NUL, is a transport violation, not guest EFAULT. No NUL in the full admitted span gives EFAULT if
   the physical tail was shorter than 4096, or ENAMETOOLONG at 4096. A NUL first
   gives the owned path, at most 4095 bytes. Empty input is ENOENT before dirfd
   errors. Invalid/duplicate/stale receipts do not release another operation.
6. After capture/empty/length validation, reserve the lowest free FD capacity
   before relative-dirfd/lookup/DAC errors, matching native EMFILE precedence.
   Reservation allocates capacity but publishes no slot; no callback can steal it.
   Resolve synchronously in Rust. Absolute paths start at the captured root;
   relative paths apply the captured dirfd result or cwd. Search is checked on
   each directory traversed, with held mount topology and byte-component paths.
   No callback or namespace mutation interleaves lookup and final publication.
7. O_NOFOLLOW preserves a terminal symlink for the final open decision, but a
   trailing slash/dot still requires directory traversal. Apply O_DIRECTORY type
   failure before terminal-symlink ELOOP. Check final read access on the actual
   inode. Unsupported node kinds remain unsupported profile, not a blocking host
   open. No payload read is required to open a canonical file.
8. Reserve slot/description/final place ownership before publishing the lowest
   free FD with offset zero. The new OFD, not the pathname or dirfd candidate,
   owns subsequent reads. Release operation-only root/cwd/dirfd holds exactly once
   after success or failure. Allocation failure publishes no FD.

## Failure, cancellation and retirement

While the core input view is exposed, only scalar result getters and the matching
capture finish are allowed. Existing read receipt/query/cancel/retire and execution
retirement exports are not exceptions to this guard. Generic action exports cannot
start, finish or retire a path-owned token.

A capture receipt always certifies that the short core scratch view no longer
escapes or remains in use. Unknown still means physical guest-span completion or
copy content is uncertain: it retains scratch, source/binding span, base holds and
the pending invocation. It is not retried. Unknown cannot be used while an
external writer still retains the core scratch view. Cancellation closes admission but cannot manufacture
ended access. A later valid stopped receipt may settle the same operation; after
cancellation or execution fault it performs cleanup without publishing an FD.
Ready cancellation can release an unstarted reservation. A trapped/incomplete
finish preserves ownership rather than claiming rollback.

FD publication and delivery of the return value are different events. Lost Worker
response must not undo or replay an open: the committed descriptor remains owned
by that execution's table until existing observed-stop retirement closes it.
A host termination request is not physical exit evidence. Same-token finish
replay is rejected by Rust. Distinct guest syscall entries within one invocation
are distinct operations: preventing transport replay of the original request also
uses the existing Node sequence/stop bridge, not a claim that Continuation can
recognize arbitrary repeated semantic calls.

Close consumes only the guest slot. A read keeps its exact OFD independently of
close/reuse, so offset/result settlement cannot retarget a newer slot. Borrowed
host standard descriptors are not closed as host resources by guest close.
For reads, validate FD/access mode, then the profile's numerical user-address
range, then the file operation. Directory reads report EISDIR, including a zero
request with low valid/NULL/unmapped numeric addresses; a noncanonical high
address still gives EFAULT first. Regular zero-length reads do not inspect low
pointer payloads. This corrects the earlier managed zero-before-address ordering,
which returned zero even for u64::MAX. Physical bounds still do not represent
virtual mapping holes, and positive regular reads keep the existing clipping
profile. No ordinary-VM EFAULT equivalence follows.

## Compatibility and measured work

Native counterexamples are recorded separately from the implementation:
NOFOLLOW on a terminal symlink gives ELOOP; DIRECTORY|NOFOLLOW gives ENOTDIR;
trailing slash follows the directory link. A readable but unsearchable directory
can be opened, but relative `.` lookup from it fails search. Empty, overlong and
pathname-capture faults precede bad dirfd results; final inode DAC failures are
not pathname-capture faults. High argument bits follow
the syscall int ABI. These are acceptance cases, not proof of all Linux behavior.
References: [open(2)](https://man7.org/linux/man-pages/man2/open.2.html),
[close(2)](https://man7.org/linux/man-pages/man2/close.2.html).

For a length-L accepted path, the captured payload is L+1 bytes, once, between
separate linear memories. The physical NUL scan and Rust validation are two
current implementation scans, not a universal lower bound. Scratch initialization
is at most 4096 bytes on first use. Root/cwd snapshot and dirfd pinning are explicit
metadata/hold work; their name copies and arena scans are not claimed inevitable.
The current resolver's per-component mount scan remains O(components * views),
beside visited-name work. FD admission still scans for the lowest free slot.

Resident file read retains the current one-copy canonical-to-guest route, not a
new N-byte JS snapshot. Source loading/integrity, guest memory traffic, syscall
slot synchronization, metadata crossings, initial allocation and retained
capacity are measured separately. Do not call any difference a Rust-language
speedup or a specification lower bound.

## Staged acceptance before publication

- Rust owner tests: exact dirfd close/reuse and bad-result capture; absolute-path
  bypass; root/cwd change after admission; final symlink/trailing slash; search and
  read credentials; detached views; CLOEXEC; FD/allocation failure with no slot.
- Capture protocol: short/long/empty/non-UTF8 input, NUL at physical tail, stale
  scratch tail, transport truncation, duplicate/stale/wrong action, all-export
  guard, ready/issued cancellation, unknown and late stopped evidence.
- Existing managed CLI, actual current translator and Node Worker: same static
  ELF native/managed output/status, own-executable reads, directory dirfd relative
  open, independent offsets, lowest-slot reuse, invalid close and closed-read.
- Existing read/stdio/startup/stop/package/boundary suites, Rust tests/clippy and
  full strict CI. Version the private Linux ABI for its new required exports;
  incompatible selected artifacts fail instead of falling back.

No production TS path/permission/OFD authority is removed by this opt-in slice.
Its new TS code must be physical transport only. Default caller migration and
removal of that default TS authority remain explicit later gates.


## Local work and instruction checkpoint

The actual quiet ELF probe records **27 guest requests**: nine openat (one NULL
rejected before capture), ten read, seven close and one exit. For its managed
`/bin/program.elf`/parent/basename inputs, eight captured NUL prefixes total
**103 logical bytes**; positive canonical reads total **14 bytes**. These counts
come from the observed request path and known input strings, not a memory-bus
meter. Startup program/translator/image transfers are separate. The retained
88-byte shared syscall slot is metadata, not a fresh 88-byte payload copy for
each request. A captured open uses three state-changing Rust exports (entry, capture
start, finish) plus scalar-result getters; those crossings are current ABI cost,
not an inevitable syscall or Rust floor.

Bounded static disassembly of the same Rust source with toolchain 1.100.0:

| Function | Wasm debug body bytes / operators | Native Rust debug body bytes / instructions |
| --- | ---: | ---: |
| path_start | 1,116 / 458 | 1,166 / 222 |
| path_finish | 2,667 / 1,056 | 2,845 / 496 |
| prepare_open_route | 678 / 286 | 800 / 142 |
| open_read | 1,653 / 697 | 2,319 / 389 |

These are unoptimized body footprints, not executed instruction counts. Called
bodies, dynamic branches and Wasm ABI-guard work are not included; Wasm operators
and native instructions are different units. The native guest's two-byte SYSCALL
also delegates work into its host kernel, so it is not comparable to the whole
Rust path/OFD implementation as a lower bound.

One five-round rotated whole-process trial after OS-cache warmup measured native
1.75 ms, managed debug 545.82 ms and managed release 493.04 ms medians. Each managed
trial includes fresh Node, translation/image construction, Worker startup, guest
requests and observed stop; each native trial includes spawn/exec. Native and
managed path spellings/filesystem authorities also differ. Debug/release samples
overlap and have uncontrolled host load. This is not a steady-syscall comparison, significance
claim, language speedup or specification lower-bound proof. A separate instrumented
prepared-Worker trace has a different measurement window and must not be subtracted
from those totals. A fixed probe's output could itself be specialized away.

The release Linux artifact is 239,569 bytes versus the 6,084,936-byte debug build;
neither is a browser distribution asset. Both pass the 58-case focused real-guest/
ABI/lifetime group with the same current translator. Debug full runtime passes
792 cases with four pre-existing fixture skips; all 167 Rust tests pass. Package,
format and dependency-boundary checks also pass locally. Full strict TypeScript,
canonical musl corpus and new-head browser/CI gates still require CI, not inference
from these local checks. No generated ELF, Wasm or disassembly is a source commit.

## Later open(2) normalization, same owner

The original openat stage above is now also entered by x86-64 open(2). Rust maps
its `(path,flags,mode)` argument positions to the same captured AT_FDCWD route;
openat retains its dirfd/path/flags positions. Relative AT_FDCWD naming uses the
current directory, while absolute naming is independent of dirfd, consistent with
the [Linux man-pages interface](https://man7.org/linux/man-pages/man2/open.2.html).

There is no second resolver, TS pathname/FD authority, standalone payload store
or individual syscall fallback. The same readonly flag mask, credential/mount
checks, pre-capture FsContext/route holds, bounded pathname view, one-shot receipt,
canonical inode/OFD, lowest slot publication and Unknown/retirement rules apply.
Flags retain low32-bit int semantics; mode is unused in this readonly subset.
Create/write/O_PATH and other unadmitted flags remain explicitly Unsupported,
not broadened or assigned fabricated Linux errno. The pending owner retains the
original syscall number so an unsupported open(2) is not mislabeled as257 after
a stopped path receipt.

The actual mixed open/openat fixture uses the same ELF natively and in the real
managed Worker. It checks absolute self-open, independent OFDs, close/reuse and a
relative spelling in isomorphic native/guest directory trees with cwd /root.
Directory-FD cases still use openat. The lost-FD-reply fixture separately covers
both numbers: neither publication loss replays the open, and the sole held table
returns only after observed exit and ordinary cleanup. Existing symlink, policy,
path-capture and SourceId invariants are reused, not relaxed by normalization.

This does not add writable files, general virtual-memory fault equivalence,
owned sendfile, threading, signals or terminal support, and does not alone prove
ordinary cat. The default TS Kernel and new-head strict CI/browser budget remain
separate gates.
