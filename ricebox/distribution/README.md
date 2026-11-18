# ricebox distribution

ricebox builds a product-independent Linux root from pinned package sources and
produces integrity-checked layers for deployment. `RELEASE` names the source
version; `packages/` contains recipes and `pins/` their source selections.

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
registry publication. Its declared Node requirement is `>=22.18`; Node 24 is the
source-package generation guidance. Browser consumers need a bundler with
module-Worker support and must serve the distribution assets separately.

The package exports `ricebox` (`createRoot` and its types), `ricebox/prepare`
(composition), and `ricebox/vite` (the Vite integration, including
`distributionAssets`). Repository paths are not additional package exports.
Native build prerequisites are not installed by this package.

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
| `runtime/check.worker.ts` | Off-thread digest and copy work |
| `runtime/directory-tree.ts` | Directory listing projection |
| `build/` | Package assembly, source builds and artifact production |
| `deployment/` | Local readers and asset collection |
| `integrations/vite.ts` | Composition and asset emission through Vite hooks |
| `verification/` | Release parity and matched native/sods workloads |

`format/` has no execution, sods, host-API or product dependency. Producers,
readers and runtime use this shared stored-format contract. Compiled modules and
other execution objects belong to `runtime/root-types.ts`, not the manifest.

## Prepared execution

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

## Build, deploy and verify

- `build/packages.sh` builds a pinned source-package cache. `fetch-sources.sh`
  verifies downloads, and `lift-dependencies.sh` applies recipe-selected updates.
- `build/assemble.sh` assembles selected packages. `package-database.ts` writes
  their inventory; `script-interpreters.ts` checks interpreters in the guest root.
- `build/prepare.ts` composes a supplied cache with pinned tools or a source
  toolchain, publishing the output only after successful composition.
- `build/distribution.ts` produces packs, blobs and translations.
  `build/distribution.sh` builds the source translators and box maker before
  invoking it; this requires Cargo, the Wasm target and a C compiler.
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

The compression pool owns its build Workers, rejects pending work on failure and
awaits termination. Failed termination remains unconfirmed; it is not a browser
Worker guarantee. Archive reads, input cloning and retained queued bytes still
have costs. No constant-memory or syscall-count guarantee is implied.

## Dependency maintenance

`maintenance/updates.py` checks upstream releases and writes verified candidate
`NAME.next` files in the current directory; it does not replace pins or build a
release. `maintenance/advisories.sh` extracts sources into temporary storage,
applies the builder's dependency adjustments and queries vulnerability data.
Both may access the network and remain separate from runtime and composition.
