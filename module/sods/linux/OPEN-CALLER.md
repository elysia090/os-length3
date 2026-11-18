# Read-only openat caller slice

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
NULL is rejected; this does not establish arbitrary Linux EFAULT equivalence.
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
   fresh view construction and the copy. No view escapes.
5. A matching receipt reports actual copied count and independent stopped/unknown
   evidence. Rust validates count against the admitted span and inspects only
   scratch[..actual], never stale tail. An actual count of zero (even for an empty path), or a short capture without
   NUL, is a transport violation, not guest EFAULT. No NUL in the full admitted span gives EFAULT if
   the physical tail was shorter than 4096, or ENAMETOOLONG at 4096. A NUL first
   gives the owned path, at most 4095 bytes. Empty input is ENOENT before dirfd
   errors. Invalid/duplicate/stale receipts do not release another operation.
6. Resolve synchronously in Rust. Absolute paths start at the captured root;
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

Unknown capture retains scratch, source/binding span, base holds and the pending
invocation. It is not retried. Cancellation closes admission but cannot manufacture
ended access. A later valid stopped receipt may settle the same operation; after
cancellation or execution fault it performs cleanup without publishing an FD.
Ready cancellation can release an unstarted reservation. A trapped/incomplete
finish preserves ownership rather than claiming rollback.

FD publication and delivery of the return value are different events. Lost Worker
response must not undo or replay an open: the committed descriptor remains owned
by that execution's table until existing observed-stop retirement closes it.
A host termination request is not physical exit evidence.

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
