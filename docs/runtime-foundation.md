# Runtime contract: execution, sources and ownership

The supported sods Linux runtime is the TypeScript `Kernel`/`RemoteKernel`
implementation. Ricebox prepares distributions and source-bound translations for
that runtime; muk creates the guest container. An optional independent Rust/Wasm
file store can own selected file payloads. It does not replace Linux syscall,
process, pathname, credential or descriptor authority.

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

## Optional file-store selection

The standalone file-store ABI is independent of the Linux runtime. A verified
release may select an ABI4 descriptor containing compressed-blob and expanded-Wasm
identities and a per-file size limit. `releaseFileStore` checks the current index;
a cached startup hint cannot select another generation. Missing descriptors retain
legacy compatibility, but a present invalid or unavailable selection fails rather
than silently changing owners. A release-selected store cannot be overridden by a
second caller selection.

`prepareTree` mounts selected pack files through the file scope. Ordinary
non-pack files are not automatically promoted. `maxFileBytes` is a per-file limit,
not a total retained-memory ceiling. Scope disposal does not authorize access by
kernels or mappings that still depend on its payloads.

See `ricebox/distribution/runtime/file-store.ts`,
`ricebox/sods/runtime/file-store.ts` and `ricebox/sods/file-store/`.

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
- The independent file store uses scratch transfers at its host boundary. It does
  not make guest reads zero-copy or remove the TypeScript Linux owner.
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
- `ricebox/distribution/runtime/test/file-store.test.ts`: release-selected storage,
  absent-descriptor compatibility and invalid-selection rejection.

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
