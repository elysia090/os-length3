# ricebox — the neutral distribution

As BusyBox is one, and as thin: the root, and the command line #80 lists, ordinary POSIX with no window. This
folder is all of it: its version (`RELEASE`), what it is made from (`pins/`), a folder per package with its recipe
and its patches (`packages/NAME/recipe.sh`), its own files (`etc/`, `usr/`), what makes it (`make/`: each
package on one pinned Alpine, then the root and its package database), and the root as layers (`layers/`).

It knows no service and nothing of why's. What runs it is not in it: on Linux a box made by muk (`../muk`); where
there is no Linux or no x86-64, the Linux and the translation sods gives (`../sods`), taken through sods' three
files and no other. Its command line's own programs are `../you` and `../otter`, each a package of it.

## Layers

The root as any static host serves it, and what reads it: an index of every path, packs named by the digest of
their table, each file fetched when first read and used only once it is what the table says. The form is
ricebox's alone: muk reads no image, and sods lends a tree without knowing what fills it.

```
layers/table.ts         a pack's table: what makes one file read alone as checked as the whole pack
layers/pack.ts          a pack's bytes a range at a time, through whatever fetch the host has (handed in)
layers/mount.ts         an index put in a tree someone lends (a port: directories, links, lazy files)
layers/fetch.ts         a download that survives what lies between a page and its server
layers/root.ts          a release read by a page: its index, its translator, its programs translated ahead,
                        and what a browser keeps of them
layers/check.worker.ts  digests and copies off the page's thread
layers/test/            node --test module/ricebox/layers/test/*.test.ts
```

What makes the layers is still `scripts/webroot*.ts`; it comes here with the release that is ricebox's own
(`docs/STRUCTURE.md`). A release of ricebox is then whole without why: the root, its layers, and beside them
`muk` and `sods` (the program, the translator as a module, and `sods/runtime`), each taken at the boundary it
publishes.
