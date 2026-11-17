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

Comparison harnesses live in `verification/`, not in the production runtime or
package entry points. They consume the distribution readers and execute matched
native/sods cases. Their child executor is private to those checks. Language workloads are readable
shell fixtures, fed byte-for-byte to both roots, not host-runner imports. The remaining
`make/` source-package and npm producers are being reviewed separately:


```
verification/distribution.ts  the layers match the root: paths, modes, links and bytes
verification/programs.ts      programs run in matching native and sods boxes
verification/commands.ts      command workloads compared; the evidence table `help` reads
verification/workloads/       offline language projects as literal shell input
verification/test/            harness contracts and release-selected file-store regression
build/distribution.ts       root archive converted to packs, blobs and translations
build/distribution.sh       source-toolchain wrapper; builds translator and box maker
build/muk-artifact.ts       the box maker put beside the layers (muk.json, a blob)
make/standin.ts               a small root for tests
```

A release of ricebox is whole without a product: the root, its layers, and beside them `muk` and `sods` (the
program, the translator as a module, and `sods/runtime`), each taken at the boundary it publishes.

## Dependency maintenance

`maintenance/updates.py` compares pinned sources with upstream releases, downloads
and verifies archives, and writes candidate `NAME.next` files in the current
working directory. It does not replace the pins or build the distribution.
`maintenance/advisories.sh` temporarily extracts pinned Rust/Go sources, applies
the same dependency lifts as the builder, and queries vulnerability data. It can
fetch and modify that temporary workspace; it is not a side-effect-free check.
Both remain separate from package generation and the runtime. Shared build
source/lift helpers remain under `make/` until their producer contracts are split.

## Composition and deployment

- `build/assemble.sh` assembles selected package trees into a root archive. Its
  `package-database.ts` writes the apk inventory; `script-interpreters.ts` checks
  interpreter resolution inside the guest root, not against host-installed tools.
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

The distribution producer and source-toolchain wrapper live in `build/distribution.ts`
and `build/distribution.sh`. Build-only AOT cache entries bind source bytes, native
translator, Wasm translator and invocation options. `file-store-artifact.ts` validates
selected artifacts, while `muk-artifact.ts` builds/packages the box maker for source
workflows. None of these belongs to the runtime's loading/cache policy.

Compression has a real `build/compress.worker.ts` entry, copied with the source
builder into the npm package. Composition still invokes the builder's TypeScript
with Node; this is not a newly promised standalone JavaScript builder API. The pool
size, compression settings, input cloning and output transfer are unchanged. Its
error/exit rejection and abnormal-path Worker cleanup remain a separate lifecycle
limitation; the entry extraction does not claim to fix those failures.
