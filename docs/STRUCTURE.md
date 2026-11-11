# Structure

What the repository is to be, how far it is from that today, and the order it is taken apart in.

## The rule

A folder under the root is a thing one would be glad to find on a release by itself: downloaded alone it is whole,
it is useful, and it says what it stands on. What is on no release by itself is inside the unit that ships it, or is
one of the few folders that make and check the rest (`scripts/`, `tests/`, `docs/`).

Units are thin, and beside one another: none holds another. Each takes only from what is under it, so a unit is cut
out with the units under it and nothing else. Three of them name the whole:

- **muk**, the thinnest: an OCI-compatible VMM. Layers at rest by their digest, and a bundle run from them. No KVM,
  no Firecracker; C on `lib` alone.
- **ricebox**, the neutral distribution, as BusyBox is one and as thin: the smallest UNIX a browser runs and the
  command line [#80](https://github.com/elysia090/os-length3/issues/80) lists, over muk. No window, ordinary POSIX,
  served from any web host as it is. It knows no service: someone else puts it under theirs.
- **root3**, the product, as Alpine stands on BusyBox: ricebox, the root's packages, the app and the command, and
  the modules over them. What a service wants is shipto's, and nowhere else.

## The units

| Folder | On a release as | What it is | What is not its | Takes from |
| --- | --- | --- | --- | --- |
| `module/lib` | (in each program of C; no file of its own) | what the units of C stand on: system calls, words, output | a C library | — |
| `module/muk` | `muk`, one static program | the OCI-compatible VMM | a kernel in a browser; a service's rules; what root3 puts in a box (a repo, dotfiles) | lib |
| `module/sods` | `xlat`, `xlat.wasm` | x86-64 made wasm ahead of the run | reading a layer (unzstd, SHA-256: muk's) | — |
| `module/ricebox` | `ricebox`, a folder any static host serves | the smallest UNIX a browser runs, and #80's command line | the app's pages; the Remote; the root's packages | lib, muk, sods |
| `module/you` | `you`, `rg` | z, rg, fd, fzf | — | lib |
| `module/otter` | `otter` | help, and what each thing is; the hooks | the work itself | lib (its hooks: ricebox, muk, sods) |
| `root/` | the root, `…-x86_64-<digest>.tar.zst`, and the same as layers | OS Length3 Linux: each package from its pinned source | ricebox's (ricebox runs it; root3 makes it) | — |
| `src/app`, `src/desktop` | the web app (`…-web.zip`), the desktop app (`.deb`, AppImage) | the faces: pages and window | judgement of their own | any |
| `src/cli` | `root3` | the command | judgement of its own | any |
| `src/core` | (in the app and the command) | what both say of a repo, its history, Home | a box run (muk's); a service (shipto's) | ricebox, muk |
| `module/shipto` (today `src/remote`) | the Remote, a Worker to deploy | what a service wants: who one is, what one may use, deliveries, its deploy | anything a box needs to run | ricebox, muk |

funk (links out of a box) and m8 (where boxes run) have no folder yet; they get one when they have something to ship.

## Today, against that

- **A release is one lump.** 0.6.4 holds the root, the web root, the web app and the desktop app. muk, xlat,
  ricebox, you and otter are on no release by themselves; you and otter only inside the root.
- **ricebox is not whole in its folder.** What serves it in a page is the app's (`src/app/prompt`, 2,051 lines,
  with the app's words, its host and the Remote's address in it); what makes the folder a host serves is
  `scripts/webroot*.ts`. Its kernel is 8,698 lines of TypeScript: not thin.
- **muk's work is still root3's core's.** A box on Linux is run by `src/core/src/prompt` (1,344 lines of Rust over
  rustix), with Home's dotfiles and the repo written into it; `src/core/src/compute` (616 lines) drives
  Firecracker, which muk's definition rules out. `muk run` exists (737 lines of C) and does not yet make the
  seccomp filter or the terminal a Prompt needs.
- **sods holds what is muk's**: unzstd and SHA-256 in `wasm.rs`, with their two crates.
- **shipto is in five places**: `src/remote` (8,403 lines), `src/core/src/remote` (2,479), and three of the
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
   then processes.
2. **sods.** The foreign decoder is run twice an instruction (0.32 G of the 1.40 G) and the lowering is keyed on its
   types (`ops.rs`, 2,070 lines). First cut: its own decoder, one pass, a table per opcode; then the calls it makes
   (a call is 8.5× native).
3. **muk takes the box from root3's core.** The seccomp filter and the terminal in `muk run`; then a Prompt is the
   bundle root3 writes, `src/core/src/prompt` goes down to that, and the Firecracker driver goes.
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
