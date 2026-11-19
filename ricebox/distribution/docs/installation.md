# Acquisition and composition

ricebox composes an explicitly selected package cache into a distribution. It
does not resolve catalogs or download packages during composition. The caller
may acquire packages through [otter](../../otter/), another trusted provider or
an existing local cache. Otter’s repository entry is
[`catalog/artifacts.ts`](../../otter/catalog/artifacts.ts); Ricebox does not
include it in its npm package.

## Local artifacts

`ricebox/distribution/RELEASE` supplies `0.0.1` for newly built artifacts. From
the checkout, assemble a native archive using a prepared package selection:

```sh
sh ricebox/distribution/build/assemble.sh SELECTED_PACKAGES NEW_NATIVE_DIR
```

The output contains `ricebox-0.0.1-x86_64-<sha256>.tar.zst`, `SHA256SUMS`,
and `manifest`. The archive contains the selected guest tree and its manifest.
The assembler does not add a launcher or site/demo files from the checkout.
The `length3-root-v3` format and guest inventory
paths are compatibility identifiers, not release names. Why uses its own
composition step to add its overlay; that is not a Ricebox artifact.

For browser use, `prepareDistribution` builds static layers from a supplied
package cache and pinned tools without acquisition. To derive layers from an
existing archive instead, use `build/distribution.sh ARCHIVE NEW_LAYER_DIR`
with the local Rust/C toolchain and dependencies already available. The generated
`webroot.json` records the source archive's version, exact size and SHA-256.
Serve its files at a caller-chosen URL; the archive itself is a separate output.

These are local build instructions, not a download URL for Ricebox 0.0.1.
Verify an externally supplied artifact against a digest and size from a trusted
source. Do not rename or repin old OS Length3 artifacts under the Ricebox name.
Public release remains subject to the target readiness check:
`node ricebox/sods/runtime/targets.ts --owed`.

## Prerequisites

The generated local npm package declares Node `>=22.18`. Use Node 24 to generate
that package from repository sources, as shown in the [setup guide](../README.md#setup).
Composition also requires Linux shell tools, GNU tar and zstd. ricebox does not
install these prerequisites.

Supply either integrity-pinned `tools` for the translator, native sods executable
and muk, or an explicit source `toolchain` for development. Source builds require
the corresponding Rust/C toolchains and Wasm target. Translator and AOT artifacts
provide executable code, not alternate file ownership; regular guest payloads
remain in sods' TypeScript Vfs.

## Acquire, then compose

```ts
import {prepareDistribution} from 'ricebox/prepare';

// acquirePackages belongs to the caller's selected acquisition provider.
const selected = await acquirePackages({
  catalog: pinnedCatalog,
  packages: ['app'],
  cache: downloadCache,
});
const distribution = await prepareDistribution({
  ...selected,
  output: newOutputDirectory,
});
```

The selected value supplies `packages`, `packageCache` and, when available,
pinned `tools`. If it supplies no tools, add them or a source `toolchain` explicitly.
`prepareDistribution` rejects a `catalog` field: acquisition must finish before
composition. It does not silently choose another cache or provider.

For Vite, use the same inputs in an async configuration:

```ts
import ricebox from 'ricebox/vite';

// selected is the acquired package/cache/tool selection above.
export default {
  plugins: [ricebox({build: {...selected, output: newOutputDirectory}})],
};
```

Alternatively pass `distribution: existingDistributionDirectory` to stage an
already prepared distribution. Do not pass both `build` and `distribution`.
Serving these assets is distinct from running guest programs and from deploying
a service.

## Ownership and failure

The caller owns the downloaded cache and tool inputs and must keep them stable
while preparation reads them. Composition checks integrity again because prior
acquisition does not make host files immutable. It does not provide a transactional
snapshot against concurrent mutation.

Use a new output directory. A complete output is renamed into place only after
composition succeeds. On failure, ricebox removes its temporary build directory,
not the provider's cache or earlier acquisition results.

Asset collection retains the selected stored bytes and enforces a per-asset limit,
not a total memory budget. Translation, archive construction and compression have
separate work and retention costs; the composition interface makes no speedup or
fixed syscall-count promise.
