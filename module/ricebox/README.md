# ricebox — the neutral distribution

As BusyBox is one, and as thin: the root, and the command line #80 lists, ordinary POSIX with no window. This
folder is all of it: its version (`RELEASE`), what it is made from (`pins/`), a folder per package with its recipe
and its patches (`packages/NAME/recipe.sh`), its own files (`etc/`, `usr/`), what makes it (`make/`: each
package on one pinned Alpine, then the root and its package database; and the root as layers), the stored distribution format (`distribution/`), the root as a
page reads and runs it (`runtime/`), and the root where it is used (`src/`: on a device, in a box).

It knows no service and nothing of a product's. The weight of running it is its own: it unpacks and holds its
root, writes the bundle its box is made from, starts that box and hands its terminal over, and in a page mounts
its layers and runs them in a Worker. What makes the box is not in it: muk (`../muk`), on Linux by the host's
kernel, and where there is no Linux or no x86-64 on the Linux and the translation sods gives (`../sods`), taken
through sods' four files and no other. A product on it (why) says what it lends a box and what it tells it, and
which root it trusts. Its command line's own programs are `../you` and `../otter`, each a package of it.

## Where it is used

```
src/unpack.rs    a root's archive unpacked: every entry made by its own name beneath a directory the kernel holds
                 (openat2: beneath the top, through no link), never over anything
src/held.rs      the roots held in a directory, the one in use, and a bundle put in place: hashed as it is
                 unpacked, renamed into place whole, or nothing left
src/bundle.rs    a root in a box: config.json and muk's words, the root's shell, what a box runs with
src/run.rs       the box run on this machine: `muk run`, at a terminal its other end to `prompt attach`; whether a
                 box can be made here; a root copied to be one of its own
```

Its bounds, counted by hand and held by its tests (`cargo test -p ricebox`):

| Its work | Bound |
| --- | --- |
| a bundle put in place | its bytes read once, each hashed once and decoded once, through one handle |
| a file of the tree | three calls: made, written, closed (where it fits a megabyte decoded at a time) |
| a directory, a link | one call; a directory come into, one more, held while its entries are made |
| config.json, n bytes | n bytes written, each once, into memory asked for once at its size |

## Layers

The root as any static host serves it, and what reads it: an index of every path, packs named by the digest of
their table, each file fetched when first read and used only once it is what the table says. The form is
ricebox's alone: muk reads no image, and sods lends a tree without knowing what fills it.

```
distribution/manifest.ts  stored release descriptors, without execution objects
distribution/pack.ts      pack format, writer and integrity checks
distribution/mount.ts     lazy files mounted through a caller-supplied neutral port
runtime/root-types.ts     prepared root values passed to execution Workers
runtime/root.ts           release loading, cache policy and session entry
runtime/worker.ts         execution through sods and muk
runtime/pack-range.ts     checked range reads through supplied host operations
runtime/download.ts       resumable downloads and integrity
runtime/startup-programs.ts programs needed for initial launch
runtime/pretranslate.ts  background translation scheduling
runtime/translate.worker.ts background translator entry
runtime/directory-tree.ts directory listing projection for callers
runtime/check.worker.ts   off-thread digest/copy entry
runtime/test/             integration and execution tests
```

The distribution directory has no dependency on execution, sods, host APIs or
product code. Runtime consumes it; producers and deployment tools use the same
stored-format contract. Execution objects such as WebAssembly modules are kept in
runtime/root-types.ts rather than serialized-manifest types.

The existing make directory still contains producers, native/web comparison and
execution tooling. Its remaining mixed responsibilities are being reviewed
separately; it is not a proposed generic build/runtime abstraction:


```
make/layers.sh, layers.ts   a release root written as layers: its index, packs and blobs, the hot programs
                            translated ahead
make/parity.ts              the layers are the root: the same paths, modes, links and bytes
make/muk.ts                 the box's maker put beside the layers (muk.json, a blob)
make/runnable.ts            each program of the root run in a box muk makes, on sods' Linux and on this machine's
make/commands.ts            the command line #80 lists, each command seen to run; the table `help` reads
make/standin.ts             a small root for tests
```

A release of ricebox is whole without a product: the root, its layers, and beside them `muk` and `sods` (the
program, the translator as a module, and `sods/runtime`), each taken at the boundary it publishes.

## Composition and deployment

- `build/prepare.ts` composes an explicit package cache with pinned tools. It
  creates an isolated temporary generation and publishes its output only after success.
- `deployment/assets.ts` validates and collects a prepared distribution's named
  assets. It does not build, execute, or invoke a bundler.
- `integrations/vite.ts` connects those two operations to Vite's hooks. It owns no
  second manifest reader or distribution builder.
- `docs/installation.md` describes the caller's acquisition and ownership contract.

The package exports `ricebox`, `ricebox/prepare`, and `ricebox/vite` remain stable.
The existing `distributionAssets` named export of `ricebox/vite` remains the same
function, re-exported from the bundler-independent implementation. Source paths
inside the repository are not additional package exports.

This separation adds no asset scan, copy or retained representation. Asset staging
still returns a Map retaining all selected stored bytes, and its limit is per asset,
not an aggregate memory bound. It verifies mutable host files again; prior acquisition
is not proof that those files remain unchanged. Neither the Vite adapter nor local
package construction publishes a release or installs missing native tools.

## Inventory and local readers

- `distribution/inventory.ts` contains normalized entries and pure inventory comparison.
  It holds no Buffer, filesystem operation or execution object.
- `host/node/tar.ts` reads native archive streams and constructs their inventory;
  `host/node/inventory.ts` reads installed directories or selects the archive reader.
- `deployment/local.ts` opens a local prepared distribution lazily. Its caller owns
  pack descriptors and calls `close()` after success or failure. This releases the
  current descriptors; later reads can reopen them, as before the separation.
- `deployment/inventory.ts` reads and verifies the complete distribution for
  comparison, preserving its `finally` close.

Local lazy reading is not asset staging: it does not inherit `assets.ts`'s eager
retention or symlink refusal contract. Verification still checks whole packs and
then reads individual files; this change does not reduce those reads or hashes.
The existing comparison and program-execution tools in make are the next boundary
being separated, not production runtime API additions.
