# Acquisition and composition

ricebox composes an explicitly selected package cache into a distribution. It
does not resolve catalogs or download packages during composition. The caller
may acquire packages through [otter](../../otter/), another trusted provider or
an existing local cache. Otter’s repository entry is
[`catalog/artifacts.ts`](../../otter/catalog/artifacts.ts); Ricebox does not
include it in its npm package.

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
