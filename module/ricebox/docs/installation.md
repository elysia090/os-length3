# Acquisition and composition

ricebox composes a selected package cache into a distribution. It does not resolve
catalog dependencies or fetch packages. A caller may use otter, another trusted
provider, or an existing local cache. No provider is embedded in the ricebox package.

The existing otter `acquirePackages` result is directly usable:

```ts
// acquirePackages comes from the caller's selected acquisition provider.
const selected = await acquirePackages({catalog: pinnedCatalog, packages: ['app'], cache: downloadCache});
const distribution = await prepareDistribution({...selected, output: newOutputDirectory});
```

For Vite, an async configuration can return `ricebox({build: {...selected, output}})`
after acquisition. There is no additional provider callback or adapter protocol.
If the catalog supplies no tools, pass either explicit pinned `tools` or a source
`toolchain`. `fileStore` remains an optional separate pinned selection; it is not
inferred from a translator artifact.

This changes the private, pre-release `prepareDistribution({catalog, ...})` form.
That old field is rejected before any acquisition or directory creation, including
when other tool options are present. Move acquisition before composition as above;
do not simply remove the field and accidentally use an unrelated cache.

The caller owns the downloaded cache and stable tool inputs. On a composition
failure, ricebox removes only its temporary build directory. It does not roll back
acquisition or remove a provider's cache. A complete output is renamed into place
only after composition succeeds. The package set and pinned input files must remain
stable while preparation reads them; this is not a transactional snapshot against
concurrent input mutation.

The split does not add a data copy or another catalog scan: otter's existing
selection is passed as package names, cache path and tool descriptors. Integrity
checks at composition remain, since acquisition does not make later host files
immutable. Time, retained bytes, translation, archive construction and asset staging
still need their own measurements; splitting the API does not prove a speedup.
