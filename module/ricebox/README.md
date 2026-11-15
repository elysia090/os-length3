# ricebox — the neutral distribution

As BusyBox is one, and as thin: the root, and the command line #80 lists, ordinary POSIX with no window. This
folder is all of it: its version (`RELEASE`), what it is made from (`pins/`), a folder per package with its recipe
and its patches (`packages/NAME/recipe.sh`), its own files (`etc/`, `usr/`), what makes it (`make/`: each
package on one pinned Alpine, then the root and its package database; and the root as layers), the root as a
page reads and runs it (`layers/`), and the root where it is used (`src/`: on a device, in a box).

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
layers/table.ts         a pack's table: what makes one file read alone as checked as the whole pack
layers/pack.ts          a pack's bytes a range at a time, through whatever fetch the host has (handed in)
layers/mount.ts         an index put in a tree someone lends (a port: directories, links, lazy files)
layers/fetch.ts         a download that survives what lies between a page and its server
layers/shape.ts         the root as a page reads it, in its shapes (webroot.json, the index, the root loaded)
layers/root.ts          a release read by a page: its index, its translator, its programs translated ahead,
                        what a browser keeps of them, the box's maker beside it, and the Worker that runs it
layers/worker.ts        the root run in a Worker: its layers mounted, the Linux sods answers, the box muk makes
layers/first.ts         the programs a first start waits for
layers/ahead.ts         what is likely run next, translated while the page has time (ahead.worker.ts)
layers/tree.ts          the root's tree for whoever shows it, and what at its top the kernel makes
layers/check.worker.ts  digests and copies off the page's thread
layers/test/            node --test module/ricebox/layers/test/*.test.ts
```

What makes the layers is here too:

```
make/layers.sh, layers.ts   a release root written as layers: its index, packs and blobs, the hot programs
                            translated ahead
make/tree.ts                a root's archive and a web root read, to compare
make/parity.ts              the layers are the root: the same paths, modes, links and bytes
make/muk.ts                 the box's maker put beside the layers (muk.json, a blob)
make/runnable.ts            each program of the root run in a box muk makes, on sods' Linux and on this machine's
make/commands.ts            the command line #80 lists, each command seen to run; the table `help` reads
make/standin.ts             a small root for tests
```

A release of ricebox is whole without a product: the root, its layers, and beside them `muk` and `sods` (the
program, the translator as a module, and `sods/runtime`), each taken at the boundary it publishes.
