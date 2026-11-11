# Structure

What the repository is to be, how far it is from that today, and the order it is taken apart in.

## The rule

The repository is split by what a person would be glad to find on a release. There are four such things, and read
from the top the code is those four: **root3**, **ricebox**, **muk**, **sods**. Each is whole when downloaded
alone, is useful alone, and says what it stands on. The smaller modules are not a fifth kind of thing: each is a
part of the one that ships it, or is what several of them stand on. There is no name between these: what cannot be
said as one of them, or as a part of one, is a model one too many, and is taken apart (below).

Each is thin, and they are beside one another: none holds another. Each takes only from what is under it, so one is
cut out with what is under it and nothing else. What a product wants never goes inward: no name of root3's, and no
word of a service, is in ricebox, muk, sods or lib.

| | On a release as | What it is | Stands on |
| --- | --- | --- | --- |
| **muk** | `muk` | the machine: an OCI-compatible VMM. A box run from an image's layers, named by their digest: on Linux by its namespaces, in a browser by answering its system calls itself. No KVM, no Firecracker | lib, sods |
| **sods** | `sods` | instructions, and where they run: a program built once (x86-64, for Linux) made to run where there is no such machine and no such kernel, at the speed of the machine it lands on. It is what takes the dull boundaries away (bare metal, one host's system against another's, what a browser allows), so that code under it is the same code everywhere. Today: x86-64 made wasm ahead of the run | — |
| **ricebox** | `ricebox`, the root, and the same as layers any static host serves | the neutral distribution, as BusyBox is one and as thin: each package from its pinned source by its recipe, and the command line [#80](https://github.com/elysia090/os-length3/issues/80) lists. No window, ordinary POSIX. It knows no service: someone else puts it under theirs | muk, sods, lib |
| **root3** | the app (web, desktop), `root3` | the product, as Alpine stands on BusyBox: ricebox run by muk, the faces and the modules a product has. What a service wants is shipto's, and nowhere else | ricebox, muk, sods |

## Read from the top

```
muk        module/muk        the machine: src/ (C: a box on Linux; the tree), runtime/ (a box in a browser), test/
             module/prompt   a box someone works in, thin over muk and with nothing of a product in it: src/ (C: the
                             terminal's other end), test/; what of a box is kept is still to come
sods       module/sods       the translator (Rust), and what loads it in a page
ricebox    module/ricebox    the distribution, 0.6.4 (RELEASE): pins/, packages/, etc/, usr/, make/
             module/you      its command line's own programs, each one file of C: z, rg, fd, fzf
             module/otter    help, and what each thing is
root3      root3/            the product, 0.0.1 (VERSION): app/, desktop/, cli/, core/, remote/
under all  module/lib        what the C stands on: system calls, words, output. On no release: it is in each
                             program made of it
beside     scripts/ tests/ docs/    what makes and checks the rest
```

What is not each one's: muk holds no package and no rule of a service, and nothing root3 puts in a box (a repo,
dotfiles); it keeps no box beyond a run and no end of a terminal, which are prompt's (module/prompt/README.md: a
run and one descriptor are all that cross). sods does not read a layer (unzstd, SHA-256: muk's). ricebox runs nothing: it is what is run. root3's
faces hold no judgement of their own; its core runs no box (muk's) and is no service (shipto's).

## Names and models one too many

Each is a second name for one of the four, or a thing between two of them that neither owns. Taken apart from the
inside out, so that nothing of a product is left further in than the product.

| The model | Where | What it is | It becomes |
| --- | --- | --- | --- |
| the kernel | was `module/ricebox/kernel` | the machine in a browser | muk's `runtime/` and `src/tree.h`: done |
| the root | was `root/` | the distribution | ricebox, its folder: done |
| src, the OS | was `src/` | the product | `root3/`: done |
| xlat | was sods' crate, its program and its wasm, `XLAT_*`, the jobs' names; 338 mentions | sods, and where it meant what runs a box, muk | `sods`, `SODS_*`; `MUK_*`: done |
| length3, Length³ OS, os-length3, OS Length3 Linux, l3 | the crates (`length3-core`, `length3-os`), `LENGTH3_*`, `/etc/length3` and the hostname in ricebox, the releases' names; 1,111 mentions | root3 where it is the product; ricebox where it is the root; nothing where it is muk's | `root3-*`, `ROOT3_*`; `/etc/ricebox`; `ricebox-0.6.4-…`, `root3-0.0.1-…` |
| the core | `root3/core`, 15,687 lines, fourteen parts that take from each other in rings | what root3 says of a repo, its history, Home, a device; with a box run (muk's) and the Remote's client (shipto's) in it | a folder of root3 to each part; `prompt` the bundle root3 writes for muk; `compute` gone |
| the web root | `scripts/webroot*.ts`, `public/webroot`, `…-l3-web.tar`; 260 mentions | ricebox as layers | ricebox's layers, made by ricebox, read by muk |
| the Remote, remote, shipto | `root3/remote`, the core's `remote`, the command's `remote`, `sync`, `git` | what a service wants | `root3/shipto`, one folder |
| scripts | `scripts/`, 4,798 lines of every unit's making and checking | each unit's own | in the unit it makes; what checks the whole stays |
| tests | `tests/` | root3's, driven as a person drives it | `root3/test` |
| runtime, src, test, tests | each unit's folders, named four ways | what runs in a page; the unit itself; its checks | one name each, the same in every unit |
| unit, module | `module/`, `scripts/units.ts` | one thing | module |
| a second kernel | sods' `kernel.rs` | where a function's control flow is made wasm | a name that says so |

## Today, against that

- **A release is one lump**, named for neither thing it holds: 0.6.4 holds the root, the root as layers, the web
  app and the desktop app as `os-length3-linux-0.6.4-…`. It is to be two: ricebox 0.6.4 (the root, its layers) and
  root3 0.0.1 (the app, the command), with `muk` and `sods` beside them.
- **muk in a browser is 8,900 lines of TypeScript**: not thin. And what serves it in a page is the app's
  (`root3/app/prompt`, 2,051 lines, with the app's words, its host and the Remote's address in it).
- **muk on Linux is still root3's core's.** A box is run by `root3/core/src/prompt` (1,344 lines of Rust over
  rustix), with Home's dotfiles and the repo written into it; `root3/core/src/compute` (616 lines) drives
  Firecracker, which muk rules out. `muk run` has the floor every box has (its own namespaces, no privilege
  gained, no capability unnamed, devices and /proc's ways to the host closed, the filter root3's launcher gave a
  Prompt) and is checked beside runc; it makes the box's terminal and gives its other end away. It does not yet make a filter
  of config.json's own or a cgroup. A box kept beyond a run, and everything a terminal is to the one at it, are
  not muk's to make: they are prompt's, which today is the rest of `root3/core/src/prompt` and `root3/app/prompt`.
- **sods holds what is muk's**: unzstd and SHA-256 in `wasm.rs`, with their two crates.
- **shipto is in five places**: `root3/remote` (8,403 lines), `root3/core/src/remote` (2,479), and three of the
  command's files (1,095).

## How far each is from its bound

Measured on one machine (Linux 6.18, a Firecracker guest), 2026-11-11. The bound is counted by hand, or is Linux's
own for the same work.

| Unit | Its work | Today | Bound | Over |
| --- | --- | --- | --- | --- |
| muk, in a browser | a call, across Workers (getppid) | 1.90 µs | 0.08 µs (Linux) | 24× |
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
| muk, on Linux | a bundle started (the one `runc spec` writes) | 119 calls, 2.0 ms | 113 calls, 1.9 ms | 1.05× |
| | reading its config.json | 50,000 instructions | 20,000 | 2.5× |
| you | rg, a line searched | 1.2× the one-thread path it replaced | not yet counted | |

## The order

Names first, from the inside out, since a wrong name is paid at every reading; then the furthest from its bound.

1. **The names**, as the table above: length3 in ricebox, then everywhere; the core's parts as root3's
   folders; the web root; shipto; each unit's scripts and tests in it.
2. **muk in a browser.** The largest, the least thin, and paid on every call. It is one thread's objects behind a
   channel: a call from another Worker is a round trip (1.9 µs), each makes an array and an object and carries its
   arguments as BigInts. To be: its state laid out in one shared memory, each call answered on the thread that makes
   it. First cut: the tree (`src/tree.h`, written, and what Linux says of every name of a whole root; the calls do
   not walk it yet), then descriptors and pipes, then processes.
3. **sods.** The foreign decoder is run twice an instruction (0.32 G of the 1.40 G) and the lowering is keyed on its
   types (`ops.rs`, 2,070 lines). First cut: its own decoder, one pass, a table per opcode; then the calls it makes
   (a call is 8.5× native).
4. **muk on Linux takes the box from root3's core.** The seccomp filter and the terminal in `muk run`; then a
   Prompt is the bundle root3 writes, and the Firecracker driver goes.
5. **A release per thing**: `muk`, `sods`, ricebox 0.6.4, root3 0.0.1. Until ricebox is released from this tree, the
   root a web build takes is the one pinned (0.6.4), whose translator is the one before these names.

## How a part is made

The same for each. What it is for in a sentence, and what is not its. Its bytes at rest and on their way laid out
first, since the layout decides the bound. The bound counted by hand for one unit of its work (an instruction
translated, a call answered, a line searched, a bundle started) in instructions, cache lines and system calls.
Written in C on `lib` until callgrind and the disassembly show that sequence. Checked against what it stands in for
over everything there is (Linux, runc, ripgrep, the one before it), byte for byte. Written again in Rust only where
it must be (what runs as wasm beside sods). The one before it deleted in the change that puts it in its place:
nothing kept beside. Its bound stays a test.
