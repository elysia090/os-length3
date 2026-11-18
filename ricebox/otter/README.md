# Otter

Otter has two independent parts. The native command shows which commands a
guest can run and looks up help pages. The Node catalog tools verify and
materialize a selected set of packages before any distribution is assembled.

## Command help

`src/otter.c` is a freestanding x86-64 Linux command. In a Ricebox root, run
`otter` for the command table, `otter NAME` for a command, and `otter -k WORD`
to search help. The table and pages come from the root; Otter does not install
packages or launch a guest.

To test the standalone command from a Linux checkout:

```sh
mkdir -p target
sh ricebox/toolchain/build.sh ricebox/otter/src/otter.c target/otter
sh ricebox/otter/test/otter.sh target/otter
```

## Package catalogs

[`catalog/artifacts.ts`](catalog/artifacts.ts) is a Node source entry, not a
Ricebox npm export. Its operations are separate:

- `publishCatalog` writes a local catalog and content-addressed blobs from an
  existing cache. It does not upload or publish to a server. The caller
  supplies runtime dependencies explicitly, independently of build dependencies.
- `resolvePackages` validates the selected dependency closure and returns it
  in dependency order. Unknown packages, cycles and unsafe file layouts fail.
- `acquirePackages` checks an HTTPS catalog against its pinned digest and size,
  fetches or rechecks the selected artifacts, and returns the package cache
  and any pinned tools for the current platform.

[Distribution composition](../distribution/docs/installation.md) is a
separate operation and can use an Otter cache or another trusted provider.
