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

The plan is not authorization to run. Normal static exec still rejects
PT_INTERP. The non-default `mapped-code` feature supplies the next code
boundary, not a launch profile:

- A compiler handle describes one authorized RX file extent at its actual
  bias. Discovering code cannot walk into another segment or another file.
- `MappedCodeSpace` belongs to one existing unshared address space. It
  binds an unchanged authenticated inode's private RX bytes, checks the
  holding mount, and revokes overlapping ranges before a VM owner changes
  them. A lookup or compile cannot reuse a revoked record.
- The alternate Wasm dispatcher has one register context and table across
  its objects. It asks the owning runtime generation for indirect targets
  instead of caching them in guest memory. It unwinds if generation
  changes during a host callback, and retires old slots before resuming
  against another generation. This does not change the static dispatcher.

### Inline VM publication (not a launch profile)

`sods/runtime/linux/mapped-vm.ts` owns a bounded private mmap arena on a
fresh, unshared memory. It is not pooled or shared by fork/clone. Only
memories deliberately prepared for this internal profile route mmap,
mprotect and munmap to it; regular start and exec still use the existing
static address space. The profile accepts a complete page-rounded RX
PT_LOAD on a read-only descriptor to an unchanged canonical DSO in the
same Vfs, and only on the holding mount. Setuid/setgid, noexec, shared
mappings, mutable source identity, anonymous executable memory and
mprotect conversions to executable are not granted. Restoring a mount
flag cannot resurrect an older executable mapping.

After a mapped address space has an owner, ordinary mprotect can reduce
permissions on fully covered initial non-executable PT_LOAD pages.
The guest linker selects its RELRO range from the ELF headers; the VM
accepts only read-only or no-access transitions that add no permission.
Initial text, stack and unmapped gaps cannot take this path. Bootstrap
pages also stay outside fixed replacement, unmap and automatic mmap.
The checked CPU and kernel-copy paths see the same published data
permissions, without retiring unrelated executable bindings.

Source callbacks and validation precede commitment. Fixed replacement,
unmapping and protection changes withdraw overlapping code before touching
the memory or making another grant. New text is published only after the
installed bytes match the checked file extent; translation never takes
instructions from mutable guest RAM. Any loss of part of an RX range
withdraws its entire text binding. Data-only changes do not discard
unrelated generations. An incomplete commit retires the address space,
rather than presenting an errno for an unconfirmed rollback.

The mapped dispatcher and compiler can unwind after a **completed**
host syscall that changed the relevant generation. It restores the result,
next instruction and saved flags, retires old code, and re-dispatches
without retrying the syscall. Throws used for wait, signal redirection,
exec or exit still go to their owners. Mapped-only flag liveness does not
change the code generated for static programs.

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

The internal mapped syscall table admits private mapping operations, a
small set of pointer-free calls and the ported regular file/path/stat
and console-write operations. Unported handlers return ENOSYS and
cannot reach the static raw-memory path. Vector I/O, devices, sockets,
signal frames, clocks and shared mappings are not enabled here. The
static process and task backends are unchanged for ordinary memories.

### Checked mapped CPU data access

The opt-in mapped compiler and dispatcher use the same installed
VM records as the kernel copies. An explicit scalar, stack or
supported SIMD load/store is checked over its entire width before
touching memory. An AMD64 address stays wide until checked; explicit
addr32 is normalized as an x86 offset before adding FS. One host
permission decision precedes each emitted load/store, including both
decisions for a read-modify-write lowering. A denied vector store has
no partial effect. The compiler-authored interrupt poll is a separate
fixed low-word read, not a guest memory grant.

The checked dispatcher refuses older and static fragments instead of
running them as mapped code. Locks and implicit atomic forms, memory
bit strings, masked vector stores, x87 memory and GS forms do not use
their static lowerings. The mapped compiler also omits the unchecked
clock fast path. Ordinary static output is unchanged.

### Checked string transfers

The mapped v4 ABI supports addr64 MOVS and STOS at element widths
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
not memory or a way to start a task. A stale caller or revoked source
discards the detached view. Tests cover the guest fixture's initial
RELRO pages and live mprotect on the same VM policy separately.

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

The scheduler proof is a small interpreter-free guest assembly fixture.
Separately, an authenticated initial image can be reserved by exactly
the unpublished Task it was prepared for. A single-use grant checks
the captured caller, descriptor table, source revisions, mapped entries
and stack again after CPU setup and at transfer. Rollback releases the
candidate without changing the prior process. Transfer retires the
old inspection and assigns the checked backing and initial context
to that Task in a held state. The owner can discard it without guest
exit, descriptor changes, or an execution event.

Held image Tasks cannot be queued, run or enter the syscall table, even
when a mapped translator is present. No normal launch path uses this
handoff. The checked loader ABI (including x86-64 FS-base startup
operations), regular exec lifecycle, precise signals/faults and Worker
execution still need proof. Normal PT_INTERP exec is still refused.

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
