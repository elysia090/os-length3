# ricebox distribution

Ricebox builds a product-independent Linux root from pinned package sources and
produces integrity-checked layers for deployment. `RELEASE` sets the default
version for new Ricebox artifacts, currently `0.0.1`. The legacy OS Length3
release remains `0.6.5`; Why sources that version from `why/LEGACY_RELEASE` and
consumes existing artifacts only through its unchanged pins.

Native execution uses [muk](../muk/) to create a Linux container and the
[terminal helper](terminal/) to attach its terminal. Browser execution uses
[sods](../sods/) in module Workers. The embedding application supplies input,
output, persistent storage and service authorization. Static hosting, including
Cloudflare hosting, does not imply execution inside that host's isolates.

## Setup

See [Acquisition and composition](docs/installation.md) for package-cache inputs,
pinned tools and output ownership. To generate a local npm package, run from the
repository root with Node 24:

```sh
node ricebox/distribution/build/npm.ts NEW_DIRECTORY
cd NEW_DIRECTORY
npm pack --ignore-scripts
```

The output directory must not exist. This creates a private local package, not a
registry publication. Install the generated tarball with `npm install --offline
--ignore-scripts /path/to/ricebox-0.0.1.tgz`. It includes the optional Everyday
presenter, not the conformance fixtures or Why site files. Its declared Node
requirement is `>=22.18`; use Node 24 to generate the package. A browser app can
stage the package's native modules or use a bundler with module-Worker support.
Serve the distribution layers separately from those modules.

For a no-framework starting point, see [Embed a staged guest terminal](docs/installation.md#embed-a-staged-guest-terminal).
A build-time declaration selects a trusted prepared environment, its terminal entry, and the cell geometry.
Staging does not acquire or publish an environment.

The package exports `ricebox` (`createRoot` and its types), `ricebox/everyday`
(the optional presenter), `ricebox/prepare` (composition), `ricebox/assets`
([framework-neutral static staging](docs/installation.md#stage-a-static-site-without-the-vite-adapter)),
and `ricebox/vite` (the Vite adapter, with the existing `distributionAssets` alias).
Repository paths are not additional package exports. Native build prerequisites
are not installed by this package.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/unpack.rs`, `src/held.rs` | Archive extraction, integrity and installed-root ownership |
| `src/bundle.rs`, `src/run.rs` | Container configuration and native launch |
| `terminal/` | Native terminal attachment helper |
| `format/manifest.ts`, `format/pack.ts` | Stored descriptors, pack format and integrity checks |
| `format/mount.ts` | Lazy mounting through a caller-supplied port |
| `format/inventory.ts` | Pure inventory comparison |
| `runtime/root.ts`, `runtime/root-types.ts` | Release loading, cache policy and session contracts |
| `runtime/worker.ts` | Execution through sods and muk |
| `runtime/pack-range.ts`, `runtime/download.ts` | Range reads, downloads and integrity |
| `runtime/pretranslate.ts`, `runtime/translate.worker.ts` | Background translation |
| `runtime/asset-cache.ts`, `runtime/check.worker.ts` | Browser cache storage and off-thread integrity checks |
| `runtime/directory-tree.ts` | Directory listing projection |
| `build/` | Package assembly, source builds and artifact production |
| `deployment/` | Local readers and asset collection |
| `integrations/vite.ts` | Composition and asset emission through Vite hooks |
| `verification/` | Release parity and matched native/sods workloads |

`format/` has no execution, sods, host-API or product dependency. Producers,
readers and runtime use this shared stored-format contract. Compiled modules and
other execution objects belong to `runtime/root-types.ts`, not the manifest.
The browser, local reader and deployment adapter bind the authenticated index
to the release’s root digest and version before using it.

## Prepared execution

Regular guest file payloads belong to sods' TypeScript Vfs. Release and AOT
artifacts authenticate sources and code; they do not select another file owner.

`createRoot(config).execution` selects the `canonical-aot-v1` profile. Its
`PreparedRoot` associates compiled artifacts with a release generation and exact
canonical sources, rather than installing byte-bearing file overlays. The
materialized `loadWebroot`/`Webroot.files` interface remains separate.

`format/executable-source.ts` validates source associations from a trusted index.
A present malformed association fails; releases without an explicit association
use the legacy derivation. These checks do not independently prove that arbitrary
compiled code corresponds to the declared source.

Before overlays, `prepareTree` captures sods' canonical inode tokens. AOT admission
uses those tokens rather than resolving a potentially replaced pathname. Hardlink
aliases may share a source; conflicting artifacts are rejected. Canonical files
remain lazy until their complete original bytes are needed. Engine compilation
failure permits ordinary execution of that source; checksum or decode failure
does not. Linux permission and mount decisions remain with sods.

Retirement closes admission but does not itself prove that a Worker or host access
has stopped. See the [runtime foundation](../../docs/runtime-foundation.md) for
compatibility and browser-transfer constraints. Node integration results are not
browser cold-start measurements.

### Prepared code for the inline dynamic VM

`build/mapped-code.ts` uses a supplied translator loader to replay ordered
dispatch misses for each exact RX placement in a verified root. It emits
content-addressed Wasm and a sidecar bound to the root generation and decoded
translator. A replay keeps earlier
discovery fences and each part's register and flag analysis, then emits one
module for the placement. Direct branches can target functions in that module.
Each PC has one dispatcher record with the target from the last part that
published it.

`runtime/mapped-code.ts` binds a trusted sidecar to a prepared tree's captured
inodes. Supply the resulting `preparedCode` to `prepareMappedInitial` with the
ordinary main, interpreter and library grants. Make artifacts available through
its reader. The first matching dispatch miss checks the blob digest and
attaches the code under the VM's live RX permission. Missing code uses the
ordinary translator. Withdrawal retires an attached piece with its mapping.

## Build, deploy and verify

- `build/packages.sh` builds a pinned source-package cache. `fetch-sources.sh`
  verifies downloads, and `lift-dependencies.sh` applies recipe-selected updates.
- `build/assemble.sh` assembles selected packages. `package-database.ts` writes
  their inventory; `script-interpreters.ts` checks interpreters in the guest root.
- `build/prepare.ts` composes a supplied cache with pinned tools or a source
  toolchain, publishing the output only after successful composition.
- `build/distribution.ts` produces packs, blobs and translations.
  `build/distribution.sh` builds the source translators, stages the layers
  with the box maker, and only then replaces the output. This requires Cargo,
  the Wasm target and a C compiler. Replacing an existing directory is not an
  atomic exchange: pause readers during replacement. On a failed restore the
  previous tree remains in the reported recovery directory.
- `deployment/assets.ts` validates and collects assets without building or
  executing them. It retains selected stored bytes in a Map; its size limit is
  per asset, not an aggregate memory bound.
- `deployment/local.ts` reads packs lazily. Call `close()` on success or failure
  to release open descriptors. Later reads can reopen them.
- `verification/inventory.ts` compares installed directories or native archives
  with complete decoded distributions. Verification checks whole packs and
  individual files, including their hashes.
- `verification/programs.ts`, `verification/commands.ts` and `workloads/` compare
  native and sods execution. These tools are not production package exports.

The web layer builder admits at most three compressions and 224 MiB of input
bodies at once. A larger member runs alone. The archive can hold one more
member while waiting, not a queue of bodies. Workers take ownership of complete
disposable buffers and return them when compression saves no bytes; inputs shared
with the allocator or kept for AOT are not moved. Archive reads, compression
scratch and the selected stored bytes for pack assembly still have separate
costs. This is not a process-memory limit. The pool stops admission on failure
and awaits all build Worker terminations; failed termination remains unconfirmed.

## Tests

`npm test` runs the distribution’s fixture-only tests, including package
assembly, packaging, deployment and the Vite integration. They do not need a
downloaded root or built Rust translator.

CI runs the execution tests with a real Sods translator and Muk. For an
isolated reproduction, provide the artifacts explicitly (paths may be absolute):

```sh
SODS_TRANSLATOR_WASM=/path/to/sods.wasm SODS_NATIVE=/path/to/sods \
RICEBOX_AOT_ELF=/path/to/program RICEBOX_MUK_FILE=/path/to/muk \
  node --test ricebox/distribution/runtime/test/*.test.ts \
    ricebox/distribution/build/test/native-association.integration.ts

RICEBOX_RELEASE_DIR=/path/to/webroot \
  node --test ricebox/distribution/verification/test/release-shell.integration.ts
```

The release shell test uses the Muk named by the prepared web root, checks its
digest and runs the release’s shell through Sods. It does not publish anything.
For BusyBox-based Sods tests, [stage the verified release fixture](../sods/README.md#runtime-tests)
explicitly; the distribution producer does not write test outputs.

### Native installed-root socket check

The Linux x86-64 `Commands` CI job reuses its staged, digest-checked static
BusyBox and runs the proof as an unprivileged user. On an already compatible
runner, from the repository root:

```sh
node ricebox/distribution/verification/test/fixtures/stage-sods-userland.ts \
  /path/to/prepared/webroot target/sods-release-fixture
cargo run --locked -p ricebox --example native-socket-proof -- target/sods-release-fixture/busybox
```

The staging destination must not exist. The test needs Rust, Node, a C compiler
with static libc, GNU tar, zstd and a runner that allows Muk's normal native
namespaces/mounts and pathname AF_UNIX sockets. A missing prerequisite fails the
test. Do not change host security settings to make it pass.

The proof assembles a synthetic native archive, rejects a wrong digest, installs
and selects the matching archive in temporary state, and runs its BusyBox shell
with Muk built explicitly from this checkout. A baseline checks for a missing
guest path. After the synthetic host peer starts listening, the guest with no
lend must get `ENOENT` on connect. A second launch grants one read-only socket
path, verifies that the neighboring canary is absent and the `/run` mount is
not marked read-only, and connects to the peer. Both endpoints pass size-sealed memfds and verify shared
writes after their creator closes the FD.

The test requests a separate network namespace rather than sharing the host's
network. It does not audit network or filesystem isolation. There is no
persistent installation, real display or real host service access, and no claim
about a released installer, Wayland, Everyday UI, or Sods-to-host transport.

## Dependency maintenance

`maintenance/updates.py` checks upstream releases and writes verified candidate
`NAME.next` files in the current directory; it does not replace pins or build a
release. `maintenance/advisories.sh` extracts sources into temporary storage,
applies the builder's dependency adjustments and queries vulnerability data.
Both may access the network and remain separate from runtime and composition.
