# Structure

What the repository is to be, how far it is from that today, and the order it is taken apart in.

## The rule

The repository is split by what a person would be glad to find on a release. There are four such things, and read
from the top the code is those four: **root3**, **ricebox**, **muk**, **sods**. Each is whole when downloaded
alone, is useful alone, and says what it stands on. The smaller modules are not a fifth kind of thing: each is a
part of the one that ships it, or is what several of them stand on.

Each is thin, and they are beside one another: none holds another. Each takes only from what is under it, so one is
cut out with what is under it and nothing else.

| | On a release as | What it is | Stands on |
| --- | --- | --- | --- |
| **muk** | `muk`, one static program | the thinnest: an OCI-compatible VMM. Layers at rest by their digest, and a bundle run from them. No KVM, no Firecracker; C with no C library | lib |
| **sods** | `xlat`, `xlat.wasm` | x86-64 made wasm ahead of the run, so a program built for Linux runs in a browser | — |
| **ricebox** | `ricebox`, a folder any static host serves | the neutral distribution, as BusyBox is one and as thin: the smallest UNIX a browser runs and the command line [#80](https://github.com/elysia090/os-length3/issues/80) lists. No window, ordinary POSIX. It knows no service: someone else puts it under theirs | muk, sods, lib |
| **root3** | the app (web, desktop), `root3`, the root | the product, as Alpine stands on BusyBox: ricebox, the root's packages, the faces and the modules a product has. What a service wants is shipto's, and nowhere else | ricebox, muk, sods |

## Read from the top

What one meets going down from the root, and why it is there:

```
muk        module/muk                 one file of C and its test beside runc
sods       module/sods                the translator (Rust), and what loads it in a page
ricebox    module/ricebox             the distribution, 0.6.4 (RELEASE)
             kernel/                  the smallest UNIX a browser runs, and its tests beside Linux
             packages/ pins/ make/    the root: each package from its pinned source by its recipe, and what makes it
             etc/ usr/                the root's own files
             its command line's own programs, each one file of C:
             module/you               z, rg, fd, fzf
             module/otter             help, and what each thing is
root3      root3/                     the product, 0.0.1
             app/ desktop/            the faces: pages and window
             cli/                     the command
             core/                    what both say of a repo, its history, Home
             remote/                  shipto: what a service wants (who one is, what one may use, deliveries, its deploy)
             funk, m8                 links out of a box; where boxes run (when they have something to ship)
under all  module/lib                 what the C stands on: system calls, words, output. On no release: it is in
                                      each program made of it
beside     scripts/, tests/, docs/    what makes and checks the rest
```

What is not each one's: muk has no kernel for a browser, no rule of a service, nothing root3 puts in a box (a repo,
dotfiles). sods does not read a layer (unzstd, SHA-256: muk's). ricebox has no page of the app, no Remote, no
package of the root (it runs the root; root3 makes it). root3's faces hold no judgement of their own; its core runs
no box (muk's) and is no service (shipto's).

## Today, against that

- **A release is one lump.** 0.6.4 holds the root, the web root, the web app and the desktop app. muk, xlat,
  ricebox, you and otter are on no release by themselves; you and otter only inside the root.
- **ricebox is not whole in its folder.** What serves it in a page is the app's (`root3/app/prompt`, 2,051 lines,
  with the app's words, its host and the Remote's address in it); what makes the folder a host serves is
  `scripts/webroot*.ts`. Its kernel is 8,698 lines of TypeScript: not thin.
- **muk's work is still root3's core's.** A box on Linux is run by `root3/core/src/prompt` (1,344 lines of Rust over
  rustix), with Home's dotfiles and the repo written into it; `root3/core/src/compute` (616 lines) drives
  Firecracker, which muk's definition rules out. `muk run` exists (737 lines of C) and does not yet make the
  seccomp filter or the terminal a Prompt needs.
- **sods holds what is muk's**: unzstd and SHA-256 in `wasm.rs`, with their two crates.
- **shipto is in five places**: `root3/remote` (8,403 lines), `root3/core/src/remote` (2,479), and three of the
  command's files (1,095).
- **The product's name is in neutral units**: `/etc/length3` and `root3 address` in otter, `length3` as the
  kernel's hostname.

## How far each is from its bound

Measured on one machine (Linux 6.18, a Firecracker guest), 2026-11-11. The bound is counted by hand, or is Linux's
own for the same work.

| Unit | Its work | Today | Bound | Over |
| --- | --- | --- | --- | --- |
| ricebox | a call, across Workers (getppid) | 1.90 µs | 0.08 µs (Linux) | 24× |
| | write 4 KiB / pread 4 KiB | 2.49 / 2.35 µs | 0.08 / 0.17 µs | 31× / 14× |
| | open+close / stat | 5.74 / 3.03 µs | 0.47 / 0.25 µs | 12× / 12× |
| | the same in turn (one thread) | 0.23 to 1.53 µs | | 2.5× to 6× |
| | fork+exec+wait / posix_spawn | 372 / 567 µs | 174 / 141 µs | 2.1× / 4.0× |
| | `echo \| cat`, 200 times in a shell | 3.9 ms each | | |
| | a root mounted (11,560 files) | 35 to 50 ms | none: an index used where it is | |
| | its tree, written to its bound and not yet what it walks: a path of a whole root | 875 instructions, 74 ns | 430 instructions | 2× |
| sods | a program first translated (git, 680,000 instructions) | 1.40 G instructions | 0.37 G | 3.8× |
| | the code it makes: a call / an indirect call | 3.4 / 6.8 ns | 0.4 / 1.5 ns (native) | 8.5× / 4.5× |
| | fib(20) / setjmp+longjmp | 86.8 µs / 21.5 ns | 15.5 µs / 2.6 ns | 5.6× / 8.3× |
| | `cc hello.c` in a box, 2.83 s | 0.79 s translating, 0.48 s compiling 811 modules | | |
| muk | a bundle started (the one `runc spec` writes) | 119 calls, 2.0 ms | 113 calls, 1.9 ms | 1.05× |
| | reading its config.json | 50,000 instructions | 20,000 | 2.5× |
| you | rg, a line searched | 1.2× the one-thread path it replaced | not yet counted | |

## The order, the furthest first

1. **ricebox's kernel.** The largest, the least thin, and paid on every call. It is one thread's objects behind a
   channel: a call from another Worker is a round trip (1.9 µs), each makes an array and an object and carries its
   arguments as BigInts. To be: its state laid out in one shared memory, each call answered on the thread that makes
   it. First cut: the tree (names to nodes, a root's index used where it is, no mount), then descriptors and pipes,
   then processes. The tree is written (`module/ricebox/kernel/src/tree.h`) and says what Linux says of every name of a
   whole root, spelled every way; the kernel does not walk it yet.
2. **sods.** The foreign decoder is run twice an instruction (0.32 G of the 1.40 G) and the lowering is keyed on its
   types (`ops.rs`, 2,070 lines). First cut: its own decoder, one pass, a table per opcode; then the calls it makes
   (a call is 8.5× native).
3. **muk takes the box from root3's core.** The seccomp filter and the terminal in `muk run`; then a Prompt is the
   bundle root3 writes, `root3/core/src/prompt` goes down to that, and the Firecracker driver goes.
4. **What serves ricebox comes out of the app**, with no word of the app's or the Remote's in it, and what makes
   its folder out of `scripts/`: then `ricebox` is on a release by itself.
5. **shipto gathered** into its folder from its five places.
6. **A release per unit**: `muk`, `xlat`, `ricebox`, `you`, `otter` beside the root and the app.

## How a part is made

The same for each. What it is for in a sentence, and what is not its. Its bytes at rest and on their way laid out
first, since the layout decides the bound. The bound counted by hand for one unit of its work (an instruction
translated, a call answered, a line searched, a bundle started) in instructions, cache lines and system calls.
Written in C on `lib` until callgrind and the disassembly show that sequence. Checked against what it stands in for
over everything there is (Linux, runc, ripgrep, the one before it), byte for byte. Written again in Rust only where
it must be (what runs as wasm beside sods). The one before it deleted in the change that puts it in its place:
nothing kept beside. Its bound stays a test.
