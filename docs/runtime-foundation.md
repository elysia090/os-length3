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

Source callbacks and validation precede commitment. Fixed replacement,
unmapping and protection changes withdraw overlapping code before touching
the memory or making another grant. New text is published only after the
installed bytes match the checked file extent; translation never takes
instructions from mutable guest RAM. Any loss of part of an RX range
withdraws its entire text binding. Data-only changes do not discard
unrelated generations. An incomplete commit retires the address space,
rather than presenting an errno for an unconfirmed rollback.

The mapped dispatcher and compiler's v2 core can unwind after a **completed**
host syscall that changed the relevant generation. It restores the result,
next instruction and saved flags, retires old code, and re-dispatches
without retrying the syscall. Throws used for wait, signal redirection,
exec or exit still go to their owners. Mapped-only flag liveness does not
change the code generated for static programs.

This proves executable-mapping authority and backend resumption, not
arbitrary guest load/store protection. Before any dynamic process can
start, the runtime still needs mapped data protections for translated
memory accesses and kernel copy-in/out, initial executable and stack
publication, and a normal scheduler/task integration. Worker execution
requires a separate synchronization proof. Tests exercise the syscall
handlers and a small CPU fixture; they do not launch the guest loader
or establish an app startup.

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
