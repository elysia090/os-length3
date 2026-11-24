# Runtime contract: execution, sources and ownership

The supported sods Linux runtime is the TypeScript `Kernel`/`RemoteKernel`
implementation. Ricebox prepares distributions and source-bound translations for
that runtime; muk creates the guest container. Regular file payloads belong to
the TypeScript Vfs, alongside Linux process, pathname, credential and descriptor
authority. Translator and AOT artifacts do not select an alternate file owner.

## Entry points and responsibilities

| Component | Contract |
| --- | --- |
| [ricebox distribution](../ricebox/distribution/README.md) | Pinned packages, canonical roots, stored integrity, release loading/cache policy and prepared-root ownership |
| [sods](../ricebox/sods/README.md) translator | Executable decoding, generated Wasm, translation facts and incremental code |
| `ricebox/sods/runtime/linux.ts` | Public Linux construction, `preparedLinux`, Vfs and source capabilities |
| `Kernel` / `RemoteKernel` | Linux paths, mounts, permissions, descriptors, processes, images, syscalls, signals and guest mappings |
| [muk](../ricebox/muk/README.md) | OCI configuration and container setup through Linux calls |
| [terminal helper](../ricebox/distribution/terminal/README.md) | Supplied PTY attachment, I/O, resize and outer-terminal restoration, not process launch |
| Host and application | Actual Wasm/Worker objects, transport, clocks, entropy, persistence and presentation |

The import checks in `scripts/units.ts` and `scripts/runtime-boundaries.ts` enforce
dependency directions. They do not prove source provenance, host termination,
Linux compatibility or performance.

Native execution runs muk against host Linux. Browser and Node execution translate
muk and guest programs through sods. `linux()` chooses `RemoteKernel` when host
capabilities and compiled memory modes permit separate CPU Workers; otherwise
`Kernel` runs guest threads in turn. Inline execution can also be requested.
These choices share the Linux implementation but have different scheduling and
host-lifecycle behavior. Static asset hosting is not evidence of isolate execution.

## Source-bound prepared execution

Ricebox's `createRoot(config).execution` supplies the `canonical-aot-v1` prepared
profile used by the application's terminal. `PreparedRoot.executables` carries
release generation, canonical-source identity, compiled artifact identity and
shared/unshared preparation mode. The materialized `loadWebroot`/`Webroot.files`
contract is separate; a prepared executable is not an empty or replacement file.

The producer and authenticated index establish the source/artifact association.
A present malformed association fails; older releases without that field use the
specified legacy derivation. Validating a digest or compiled module does not prove
that arbitrary Wasm is a correct translation of its declared source.

`prepareTree` captures realm-local canonical inode capabilities before overlays.
`preparedLinux` validates those capabilities against the original Vfs and revision,
not a newly resolved pathname. Conflicting aliases/artifacts and incompatible
memory modes fail admission. Changed sources are not attached and retain ordinary
execution fallback. Executable permissions, credentials and mount policy remain
Linux decisions, not consequences of successful compilation.

A successful whole-AOT start need not read the original ELF. Loadable segments and
translation facts do not reconstruct the complete source file: ordinary reads,
self-file access, hashing, incremental translation and fallback may demand the
canonical bytes. Those reads use the normal authenticated pack path. Compilation
failure can fall back to the canonical file; integrity or decode failure must not
be disguised as a compilation miss.

Relevant implementations:

- `ricebox/distribution/format/executable-source.ts`
- `ricebox/distribution/runtime/prepared-executable.ts` and `prepared-tree.ts`
- `ricebox/sods/runtime/linux/executable-source.ts` and `linux/process.ts`
- `ricebox/sods/runtime/translation/share.ts`

### Static exec transaction

The translated initial start and guest `execve` use the same static
execution transaction under `ricebox/sods/runtime/linux/exec/`. Preparing
walks the caller's root and mounts, selects the source-bound artifact or
ordinary translation, calculates the SysV stack and prepares a private
descriptor table where necessary. It changes no guest image or descriptor
slots. Lazy canonical files remain lazy on prepared static starts.

Rejected input (including an overlong initial stack) leaves a live caller
running the old image. An initial candidate with rejected input has neither
a runnable task nor a published PID. Once exec starts retiring the old
image, later host/cleanup failures are not reported as recoverable guest
errno. `ExecCommitError` retains the uncertain owners and prevents resuming
or retiring them through an ordinary retry. It does not prove a Worker
stopped or grant permission to release the host's tree. An unresolved tree
cannot be adopted for another kernel or exec, and a fatal Worker rehearsal
does not hand it off to the foreground. The embedding closes admission,
requests Worker stop separately, and replaces the isolated owner rather
than recycling its resources on an unconfirmed stop. Memory allocation
and backend installation still belong to this irreversible phase; they
are not claimed to roll back.

This boundary does not admit dynamic ELF executables. The static auxiliary
vector and same-image memory/instance reuse remain in effect.

### Dynamic load preparation (not execution)

`sods/src/elf/load.rs` describes a bounded profile of AMD64 Linux ELF64
PIEs, interpreters and shared objects. A versioned Wasm metadata export
supplies file-backed load ranges and program-header facts when built with
the non-default `dynamic-load-plan` feature. It never calls
the interpreter, reads another file or resolves a shared library.
`sods/runtime/linux/exec/dynamic-plan.ts` consumes those facts with the
existing exec source checks. It resolves PT_INTERP from the caller's
guest root, honors executable permissions and mounts, binds the selected
file to the caller's authenticated source capability, and plans separate
main/interpreter placements plus the initial entry and auxiliary facts.
A shared library's optional PT_INTERP is not a second interpreter.

The opt-in `mapped-code` feature supplies the code backend used by
`prepareMappedInitial`. The handoff checks the source and VM again before
it publishes the first task.

- A compiler handle describes one authorized RX file extent at its actual
  bias. The translator reads the ELF headers separately and holds the RX
  bytes for the lifetime of that binding. Discovery stays within the extent.
  On a miss the built-in translator's output is compiled synchronously from
  its Wasm memory. The mapping is checked again before the compiled fragment
  is installed. The emitter derives XMM imports from register synchronization.
  Scalar fragments carry the common import prefix without the XMM globals.
- `MappedCodeSpace` belongs to one existing unshared address space. It
  binds an unchanged authenticated inode's private RX bytes, checks the
  holding mount, and revokes overlapping ranges before a VM owner changes
  them. The inode and mount notify it synchronously of changes that revoke
  execution. During a file mmap, the code owner supplies the exact RX bytes
  to the VM for publication. When binding a boot image, it compares the
  installed text with the file.
- The alternate Wasm dispatcher has one resident register context and one
  code table across its objects. It installs numbered function exports
  directly in that table. It resolves published PCs in its private index
  and sends PCs absent from the index to the host for resolution.
  A publication change during a host callback unwinds the Wasm frames.
  The dispatcher then evicts fragments whose exact RX bindings were
  withdrawn. The remaining fragments keep their compiled code and
  compiler handles. Their instance-local table base lets the dispatcher
  compact vacated slots before resuming.
  The embedding Kernel can set `mappedCodeBytes` for the encoded fragments
  retained by each mapped dispatcher. The default is 64 MiB. Wasm engine
  code and other process memory have separate costs.

### Inline VM publication (not a launch profile)

`sods/runtime/linux/mapped-vm.ts` owns a bounded mmap arena on a
fresh, unshared memory. Threads within that process use the same arena.
The backing memory grows in batches because each growth updates all of
its Wasm importers. Only installed regions publish page permissions.
Mapped memory stays outside the memory pool and process forks. Only
memories deliberately prepared for this internal profile route mmap,
mprotect and munmap to it; regular start and exec still use the existing
static address space. The profile accepts a complete page-rounded RX
PT_LOAD on a read-only descriptor to an unchanged canonical DSO in the
same Vfs, and only on the holding mount. Setuid/setgid, noexec, shared
executable mappings, mutable source identity, anonymous executable memory and
mprotect conversions to executable are not granted. Restoring a mount
flag cannot resurrect an older executable mapping.

The prepared tree can supply a bounded, realm-local catalogue of
already authenticated dependency inodes. It is a snapshot of exact
source tokens from that Vfs, not a path search or a list supplied by
guest code. The dynamic plan and held handoff recheck the catalogue;
the VM consumes that same catalogue without reading library payloads
at preparation. An executable mmap looks up the descriptor's exact
inode and checks that member again, together with its holding mount
and the required RX extent. Initial main/interpreter objects do not
automatically authorize library mappings.

Read-only and executable private mappings of captured libraries can retain
the file's owned copy-on-write backing. The VM publishes data rights for a
deferred page after copying it on first access. Translation reads the
validated file extent, and the Wasm data checks use the published rights
once a page is ready. `mprotect` and partial unmaps preserve the surviving
file offsets. The kernel counts sources of live mappings as in use when
reclaiming the file cache.

After a mapped address space has an owner, ordinary mprotect can reduce
permissions on fully covered initial non-executable PT_LOAD pages.
The guest linker selects its RELRO range from the ELF headers; the VM
accepts only read-only or no-access transitions that add no permission.
Initial text, stack and unmapped gaps cannot take this path. Bootstrap
pages also stay outside fixed replacement, unmap and automatic mmap.
The checked CPU and kernel-copy paths see the same published data
permissions, without retiring unrelated executable bindings.

File-backed `MAP_SHARED` data can be mapped with read-only or no-access
permissions. A read-write memfd description also permits writable shared
views for uses such as `wl_shm`. An installed view follows its inode after
descriptor close. The VM owns page rights, split offsets and retirement on
unmap, replacement and process exit. The file publishes changed byte ranges
to its views. The first store to a clean memfd page uses the checked access
import. The VM then grants fast stores to that page until the next
publication. Writeback visits only tracked pages at syscall and scheduler
boundaries. Whole pages beyond EOF stay inaccessible until the file grows,
and writes to the final page's padding do not extend the file. Anonymous
and executable shared mappings remain outside this profile.

Source callbacks and validation precede commitment. Fixed replacement,
unmapping and protection changes withdraw overlapping code before touching
the memory or making another grant. New text is published only after the
installed bytes match the checked file extent; translation never takes
instructions from mutable guest RAM. Any loss of part of an RX range
withdraws its entire text binding. Data-only changes do not discard
unrelated generations. An incomplete commit retires the address space,
rather than presenting an errno for an unconfirmed rollback.

The inode and its mount notify their bound code spaces when executable
authority changes. The notification withdraws affected ranges and
advances the generation synchronously. A generation read is a single
token read. Each code space subscribes once per source or mount and
removes its subscriptions when the last dependent range retires.

After a **completed** host syscall changes the code publication, the
mapped dispatcher restores the result, next instruction and saved flags,
reconciles live code and resumes at that next instruction. Throws used
for wait, signal redirection, exec or exit still go to their owners.

The mapped core resolves published PCs in its own indexed memory. Only
the core and the attachment owner can address this memory. The key
comparison uses the entire architectural PC. Only an absent key
calls the host resolver. When code is withdrawn, the attachment owner
rebuilds the lookup from surviving functions and their new slot numbers
after unwinding the previous Wasm frames.

### Bounded mapped kernel copies

The installed region table is also the data permission authority. A
checked kernel copy pins the process, current memory and mapping lifetime.
It never lends out a guest array or DataView. Whole copies require every
covered byte to permit the access. A regular file transfer can stop at
the first inaccessible page, with at most 1 MiB in one copy. Path strings
must terminate in readable pages. A file callback cannot publish a copy
or advance its descriptor after the memory or descriptor identity changed.
Data-only changes fence pending copies even when code generation stays
the same.

The internal mapped syscall table admits the mapping operations above, a
small set of pointer-free calls and the ported regular file/path/stat
and console-write operations. Private stack reservations use the ordinary
anonymous mapping and protection paths. Unmapping clears released bytes
so fresh mappings can leave already-zero pages untouched.
The clock queries and getrandom use
checked output copies. Futex wait and wake use the ordinary queue with
checked words and timespecs. Timeout and cancellation release the queue's
backing reference when its last waiter goes away. Poll and ppoll use the
same descriptor readiness and scheduler with checked pollfd arrays.
An eventfd read consumes its counter after the checked eight-byte copy
succeeds. A memfd uses the ordinary file lifecycle and descriptor flags.
Directory iteration publishes whole entries before advancing its cursor.
Both readlink variants use the guest's normal pathname resolution.
Console writev gathers checked copies of
the input vectors before delivering one write. Mapped clients can connect
local Unix streams using checked socket addresses. Their `sendmsg` and
`recvmsg` use the ordinary socket queues and `SCM_RIGHTS` ownership rules.
The receive path checks the guest's data, address and control outputs
before consuming the message. Unported handlers return ENOSYS. Ordinary
memories use the static process and task backends.

### Checked mapped CPU data access

The VM publishes a byte of data rights per guest page in a separate
64 KiB Wasm memory owned by the core. Scalar, stack and SIMD operations
pass the wide effective address and a packed width and rights operand.
The core checks the wide address before narrowing and reads the first
page's rights. It computes the last byte only for offsets close enough
to a page boundary to cross, then checks the second page when required.
Stores from a register or immediate can check before fetching their value.
Explicit addr32 is normalized as an x86 offset before adding FS. A
denied access reports its original span to the host before any data
changes. The dispatcher checks code and owner lifetime at entry and
host callback boundaries. Kernel copies still use the same installed
VM records.

The checked dispatcher refuses older and static fragments instead of
running them as mapped code. Threads on a private mapped address space
run in turn. Within a turn, locked
ADD, SUB, AND, OR, XOR, CMPXCHG, XADD, memory XCHG and modifying bit
strings use checked loads and stores. Bit strings check the full word
selected by the signed register offset.
ADD, SUB, AND, OR and XOR with a memory destination carry the checked
address through both operations. A denied update reports the first failed
access in read-then-write order.
CMPXCHG requires a writable destination even when the comparison fails.
Other locks, masked vector stores, ordinary x87 arithmetic memory operands
and GS forms remain outside the mapped instruction
profile. The mapped compiler also omits the unchecked clock fast path.
Mapped stack pages are cleared when released. Only the static pool
needs the stack low-water mark that translated static code records.

### FXSR in the mapped CPU

| File | Responsibility |
| --- | --- |
| `sods/src/fpu.rs` and `frame.rs` | Lower FXSAVE, FXRSTOR and MXCSR instructions. Move XMM0–15 in the current Wasm frame. |
| `sods/src/x87.rs` and `x87/fxsr.rs` | Own x87 registers and physical tags. Encode and restore the FXSR image and write the 28-byte FNSTENV environment. |
| `sods/runtime/translation/x87.ts` | Copy x87 image bytes across the coprocessor's Wasm boundary. |
| `sods/runtime/linux/exec/mapped-dispatcher.ts` | Validate alignment and MXCSR, use the VM's span check, and retire the task's x87 handle after unwind. |
| `sods/runtime/linux/mapped-vm.ts` | Supply the same published page permissions used by the kernel copies and other mapped CPU instructions. |

The mapped dispatcher checks all 512 bytes before the CPU copies register
state. A denied save writes nothing, and a denied restore changes no
registers. The XMM transfer uses that same checked address without
another host call. FXSAVE leaves the 48 software-owned bytes at the end
of the image untouched. CPUID advertises FXSR on the mapped backend.
MXCSR starts at `0x1f80` and supports round-trip state transfer. Wasm SSE
arithmetic requires the initial control settings and currently does not
accumulate the six MXCSR exception flags.
Memory forms of FNSTCW, FLDCW and FNSTSW use checked two-byte accesses
and keep the saved x87 instruction and data pointers.

### Checked string transfers

The mapped ABI supports addr64 MOVS and STOS at element widths
1, 2, 4 and 8, with their ordinary segments, with or without REP.
The compiler makes one bounded VM call (up to 1 MiB). The VM checks
the complete destination and, for MOVS, the complete source before
writing. Zero count touches neither pointer. For non-overlapping
transfers, MOVS does one range copy; when a write feeds unread
source, it copies in architectural element order. STOS repeats the
little-endian element. RSI/RDI, and RCX for REP, update only after
the successful transfer; the instruction does not change flags.

The bounded inline profile rejects out-of-policy operands before
any partial string effect. It does not emulate Linux's partial
execution and restart after a real page fault. Other string forms
such as SCAS/CMPS, other address sizes and segment overrides remain
unsupported. Neither old artifacts nor the static raw bulk path
can supply a mapped transfer.

### Detached initial Linux image

`exec/dynamic-image.ts` can seed a fresh, unclaimed mapped memory from
the authenticated main and guest-interpreter plan. It installs the
page-aligned file bytes and zero-initialized BSS, records R/W access
for each page, and binds executable text only to the exact unchanged
RX file extents. The non-executable stack and gaps have distinct
permissions; available linear memory does not make a gap accessible.
Any failed validation or source callback discards the private candidate.

The two start addresses have different meanings: the first PC is
the guest interpreter's, while AT_ENTRY and AT_PHDR describe the main
executable and AT_BASE is the interpreter's load bias. The shared
stack formatter keeps the static auxv and lays a bounded, aligned
Linux stack for the mapped profile with argv, env, IDs, random bytes
and an AT_EXECFN copy of the named guest path. This adds no privilege
transition.

The returned image exposes only permission evidence and bounded copies,
not memory or a way to start a task. A stale caller or revoked initial
source discards the detached view. Dependencies are checked at the
handoff boundary, not on each inspection or segment callback. Tests
cover the guest fixture's initial RELRO pages and live mprotect on the
same VM policy separately.

### Inline mapped Task lifecycle (not executable admission)

An internal, unpublished Task can prepare its CPU over a single owned
mapped VM with already authenticated library text and a writable arena
stack. The normal Kernel run queue, slice handling, syscall screening
and wait/retry logic own that Task and ordinary static Tasks. Mapped
execution uses its own checked dispatcher; it never uses the static
byte views, clock fast path or instance pool.

On a wait, Wasm frames unwind. The same dispatcher restores the completed
call's result and next PC as it does for a completed mapping-changing
syscall. An in-flight exit request revokes the VM and prevents any
translated code from resuming. The kernel publishes normal process exit
only after the frame has unwound and the backend releases its artifacts.
Unconfirmed backend retirement retains the task and tree, not a wait
status or permission to try cleanup again.

On this backend, x86-64 `ARCH_SET_FS` and `ARCH_GET_FS` use only the exact
active Task's screened syscall. SET accepts a base in the bounded guest
address space and needs no dereference. Its result and FS update take
effect together after the old Wasm frames unwind, before the next PC
runs. That does not change the mapping generation. GET copies one
little-endian 64-bit word using the checked whole-span VM policy. Other
`arch_prctl` operations do not fall back to the static backend.

The same screened Task can use `set_tid_address` to register its current
clear-tid pointer and get its namespace TID. Registration never reads or
writes that address. A null pointer cancels it; addresses outside the
inline address profile cannot alias valid ones. A departing thread gives
up its context before the kernel clears its writable word and wakes a
join. On the final thread's ordinary exit the VM first pins the word and
revokes ordinary access. After unwind and backend retirement the kernel
rechecks ownership and clears that word on the original backing before
publishing exit.

Checked `clone` and `clone3` can create a thread that shares its process's
VM, filesystem context, files and signal dispositions. One dispatcher,
page-rights memory and compiled code table serve the address space.
`mapped-registers.ts` moves the scalar and XMM registers and MXCSR between
the Wasm globals and private slots only when switching threads. The
dispatcher owns each thread's x87 handle separately. The scheduler owns
TIDs, futex queues and publication after preparation. Process forks,
robust-list operations and guest signal frames remain outside this path.

The scheduler proof is a small interpreter-free guest assembly fixture.
Separately, an authenticated initial image can be reserved by exactly
the unpublished Task it was prepared for. A single-use grant checks
the captured caller, descriptor table, source revisions, mapped entries
and stack again after CPU setup and at transfer. Static exec and the
held transfer share caller preflight, credentials, metadata, and
close-on-exec operations. Before any descriptor is closed, rollback
releases only the candidate image. On held commit, close-on-exec acts
on the fresh process's private table, then the same source/stack
authority rechecks the image before the backing and initial context
are assigned. An unconfirmed close retains the exact owner; it is not
rolled back or retried. A committed held Process has its main executable
identity, arguments, credentials and initial layout, but no published
PID or queue entry. Discard retires the whole unpublished owner,
including an empty, fully returned descriptor table. The retired Process
cannot run a syscall or publish a guest exit or startup event.

A held image cannot run or enter the syscall table. Its receipt can
recheck the original generation, entries, permissions, stack and library
catalogue without publishing it. Only the explicit internal handoff can
consume that exact receipt and publish its Task. Like the interpreter-free
arena and ordinary static start, it uses one PID/cgroup/terminal owner and
the normal queue. The same original entry proof is rechecked before the
first dispatcher turn. Registers, memory ownership and syscall admission
remain fenced until then, or through retirement if that proof is revoked.
A rejected preflight leaves the receipt available for discard; uncertain
publication retains the exact owner without retry.
The packed-root publication test verifies the held receipt. A bounded
acceptance run with the pinned Debian 13 loader and libc, a locally
compiled fixture PIE and DSO, and a current mapped translator verified
the normal queue through one zero-status stop. It checked the exact
console bytes, then the task, process, VM, code, fds and initial mounts
after retirement. The internal fresh-init pilot uses the same private
working directory, console and first-Task ownership as static start. Mapped stdout
and stderr are explicitly write-only. It uses a provisional PID 1 in the
held image and reserves the number only at publication. Discard returns the
unpublished resources. The receipt uses inputs already authenticated in
that guest root.

The [Quickshell browser fixture](../ricebox/everyday/test/wayland/README.md#optional-quickshell-browser-check)
runs the pinned Debian program in a dedicated Chrome Worker with a translated
Wayland listener. It checks the first and resized frames and retires both
guest kernels. The fixture covers the opt-in inline profile with either
prepared code or on-demand translation. General dynamic `execve`, broader
loader ABI coverage, signal delivery and page-fault restart remain follow-ups.

## Lifetime, failure and retirement

A prepared tree can outlive several rehearsals and runs. Its disposal requires
all kernels, images, mappings and embedding users to have ended; it is not a
per-run cleanup operation. Ending the owning Worker realm is a distinct lifecycle
boundary.

`PreparedLinuxError` retains a partially constructed kernel and its attached images
for explicit cleanup. It does not assert rollback or Worker termination. Source
and mapping invalidation must prevent stale captured capabilities or cached images
from being revived after partial publication.

Ricebox's Worker closes admission during retirement and tracks in-flight work and
possible owners. An observation count is not collection authority. Stop requests,
settled promises, guest exit, Worker exit and released host accesses are different
events. Timeouts and acknowledgements must not be promoted into stronger evidence.
Original errors and cleanup failures remain visible, including uncertain retirement.

The embedding still owns console delivery and persistent-storage synchronization.
Guest output acceptance is not a universal guarantee of delivery or durable storage.

## File payloads and persistence

Regular files, including lazily loaded canonical pack files, use the TypeScript
Vfs payload implementation. Source-bound AOT changes how code is attached, not
which component owns those files. Distribution artifacts select executable code
and authenticated source bytes, not a separate file-storage engine.

Canonical bytes may be demanded after startup by reads, mappings or translation.
The tree and its readers must remain available for those operations. Host cache
and persistent-storage policy remain the embedding's responsibility; in-memory
Vfs ownership does not itself provide durable storage or a total memory budget.

## Copies and cost boundaries

- Mapped load validation transfers the ELF header, program headers,
  dynamic entries and interpreter path. The parser bounds PT_LOAD
  segments against the original file length. The translation instance
  receives and keeps just the admitted executable extent, until the
  binding closes or the translator is renewed.
- The translator's independent-buffer JS/Wasm interface copies source bytes into
  linear memory and copies output bytes out. Generating output is additional work;
  these interface costs are not universal Rust or translation lower bounds.
- Shared-mode preparation can keep data segments outside the module so thread
  instantiation does not rewrite existing guest memory. Initial execution must
  still populate the appropriate guest storage.
- Lazy source loading avoids only bytes not demanded. Rehearsal can move a read
  earlier rather than eliminate it. Pack tables, decoding, hashing and caching
  have separate costs.
- Canonical Vfs bytes and guest linear memory are distinct storage. Guest reads
  and mapping publication must transfer the required bytes; shared execution
  memory does not make every file operation zero-copy.
- Mapping publication and source invalidation must account for aliases and partial
  failure. A constant crossing count is an interface property, not proof of an
  optimal implementation.

Measure compilation, startup, steady execution, logical copy volume, retained
memory and wire transfer separately. Wasm operators, native encoded bytes,
syscalls and physical memory traffic are different units. Neither language choice
nor a folder boundary establishes a speedup or compatibility guarantee.

## Tests and recorded evidence

Current regression sources cover the supported contracts:

- `ricebox/sods/test/runtime/kept.test.ts`: whole-AOT lazy-source execution.
- `ricebox/distribution/runtime/test/execution-profile.test.ts`: generation and
  source identity, hardlink conflicts, fallback and late executable handling.
- `ricebox/distribution/runtime/test/prepared-execution.test.ts`: prepared execution
  through the actual guest/container path.
- `ricebox/distribution/runtime/test/worker-lifetime.test.ts`: admission closure,
  retained owners and retirement ordering.

Historical release qualification is not a result for every subsequent checkout.
For the pinned 0.6.5 root, archive SHA-256
`ec84d6a4f34359f322726e323e294b03987a19b1aa544563c846ca1a83060ee3`,
[CI run 44119391578](https://github.com/elysia090/os-length3/actions/runs/44119391578)
at commit `3f39aa91607f8756b9b157980df09b9bf3f2c68f` passed all 26 jobs, including
strict TypeScript and the unchanged first-Prompt browser check. Recorded transfer
was 5,774,090 cold bytes and 14,185 warm bytes, below that test's 6 MB cold ceiling.
The pinned Bash still demanded canonical ELF bytes through an incremental miss.
Those measurements establish neither zero source reads nor a native display/FD
bridge. Changes to artifacts, host behavior or startup demand require fresh checks.
