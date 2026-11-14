# Structure

What the repository is to be, how far it is from that today, and the order it is taken apart in.

## Current responsibility boundary

Three units, each one thing, and what each publishes is all another may take (`scripts/units.ts` checks every
import in the repository, tests and scripts too).

| | It is | It publishes | It takes |
| --- | --- | --- | --- |
| **muk** | an OCI bundle's box made, isolated, started and waited for: one C program, for Linux and nothing else | `muk run`; nothing is imported from it | lib |
| **prompt** | a terminal attached to a descriptor it is given: one Rust program that starts no process | `prompt attach FD`; nothing is imported from it | nothing |
| **sods** | a program run where its machine, its kernel or its system is absent: translation and what a translation is kept by, the Linux a program asks for, every difference between hosts | `sods`, its translator as a module, and four files: `runtime/translate.ts`, `runtime/linux.ts`, `runtime/host.ts`, `runtime/targets.ts` | lib |

muk is thin because it has one contract, the OCI runtime bundle read as runc reads it (`module/muk/test/muk.sh`
compares the two), and no second one: it reads no image and has no code for a host that is not Linux. What differs
by where a program runs is sods', all of it and nowhere else
([#191](https://github.com/elysia090/os-length3/issues/191)): `module/sods/runtime/targets.ts` is the table of every
input instruction set, machine and host, each verified, unverified, unimplemented or excluded with its reason. So
where there is no Linux, the same C muk runs over the Linux sods answers: a box is made by `muk run` of one bundle
on every host (below, A Prompt is a bundle), in a page's Worker and in node as on a Linux machine.

An image's layers are the distribution's: their form, what writes them and what reads them are ricebox's
(`module/ricebox/layers`), mounted into a tree sods lends through a port neither side names the other by. What makes
a translation reusable (the program, the translator, the ABI, the options) is one key in sods
(`src/identity.rs`), and translations are kept under it by sods (`src/cache.rs`; in a browser, `madeBy`); which
programs are translated ahead and shipped is ricebox's, in its layers. The caller (a product) assembles: it starts
muk, hands prompt the terminal, and decides how long a box lives.

`module/lib` is shared compile-time C support. `module/sods/lib` is private support for sods' runtime. Alternative
platform backends are exclusive choices; a translator, its ABI adapter and private helpers are complementary parts
of one backend. The product's launcher is `muk run` and `prompt attach` and nothing else (below, A Prompt is a
bundle). The older roadmap below describes historical targets and is not a completion claim.

## The rule

The repository is split by what a person would be glad to find on a release. There are four such things, and read
from the top the code is those four: **why**, **ricebox**, **muk**, **sods**. Each is whole when downloaded
alone, is useful alone, and says what it stands on. The smaller modules are not a fifth kind of thing: each is a
part of the one that ships it, or is what several of them stand on. There is no name between these: what cannot be
said as one of them, or as a part of one, is a model one too many, and is taken apart (below).

Each is thin, and they are beside one another: none holds another. Each takes only from what is under it, so one is
cut out with what is under it and nothing else. What a product wants never goes inward: no name of why's, and no
word of a service, is in ricebox, muk, sods or lib.

| | On a release as | What it is | Stands on |
| --- | --- | --- | --- |
| **muk** | `muk` | the machine: an OCI-compatible VMM. An OCI bundle's box made, isolated, started and waited for, by Linux's namespaces; where there is no Linux, the same program over the Linux sods answers. No image, no KVM, no Firecracker | lib |
| **sods** | `sods` | instructions, and where they run: a program built once (x86-64, for Linux) made to run where there is no such machine and no such kernel, at the speed of the machine it lands on. It is what takes the dull boundaries away (bare metal, one host's system against another's, what a browser allows, one instruction set against another), so that code over it is the same code everywhere. Today: x86-64 made wasm ahead of the run, and the Linux it asks for answered in a page, a Worker and node | lib |
| **ricebox** | `ricebox`, the root, and the same as layers any static host serves | the neutral distribution, as BusyBox is one and as thin: each package from its pinned source by its recipe, the command line [#80](https://github.com/elysia090/os-length3/issues/80) lists, and its layers (their form, what writes and what reads them). No window, ordinary POSIX. It knows no service: someone else puts it under theirs | muk, sods, lib |
| **why** | the app (web, desktop), `why` | the product, as Alpine stands on BusyBox: ricebox run by muk, the faces and the modules a product has. What a service wants is shipto's, and nowhere else | ricebox, muk, sods |

muk and sods do not depend on each other's implementation: what they agree on is Linux itself (the executable
format, the system calls), and no file of one imports a file of the other. ricebox takes sods through sods' four
files and muk as a program; nothing under ricebox takes from anything over it.

## Read from the top

```
muk        module/muk        the machine: src/ (C: a box on Linux), make/, test/, tool/
             module/prompt   a terminal attached, with nothing of a product in it: src/ (Rust), test/
sods       module/sods       src/ (Rust: the translator, a translation's identity, the cache), runtime/ (its four
                             files; translation/, linux/), lib/ (C, private), test/
ricebox    module/ricebox    the distribution, 0.6.4 (RELEASE): pins/, packages/, etc/, usr/, make/, layers/
             module/you      its command line's own programs, each one file of C: z, rg, fd, fzf
             module/otter    help, and what each thing is
             module/everyday the look and feel, changed by the one who uses it: what a face is drawn through
                             (ricebox has no window of its own, and this layer for one); it knows no product
why      why/            the product, 0.0.1 (VERSION): app/, desktop/, cli/, core/, remote/
under all  module/lib        what the C stands on: system calls, words, output. On no release: it is in each
                             program made of it
beside     scripts/ tests/ docs/    what makes and checks the rest
```

What is not each one's: muk holds no package and no rule of a service, and nothing why puts in a box (a repo,
dotfiles); it reads no image, keeps no box beyond a run and holds no end of a terminal (prompt's:
module/prompt/README.md, one descriptor is all that crosses). sods reads no layer and knows no image's form: it
lends a tree, a digest and a decoder to whoever does (ricebox). ricebox runs nothing: it is what is run. why's
faces hold no judgement of their own; its core runs no box (muk's) and is no service (shipto's).

## Names and models one too many

Each is a second name for one of the four, or a thing between two of them that neither owns. Taken apart from the
inside out, so that nothing of a product is left further in than the product.

| The model | Where | What it is | It becomes |
| --- | --- | --- | --- |
| the kernel | was `module/ricebox/kernel`, then muk's `runtime/` | the Linux a program asks for where there is none | sods' `runtime/linux/` and `lib/tree.h`: done |
| the root | was `root/` | the distribution | ricebox, its folder: done |
| src, the OS | was `src/` | the product | `why/`: done |
| xlat | was sods' crate, its program and its wasm, `XLAT_*`, the jobs' names; 338 mentions | sods, and where it meant what runs a box, muk | `sods`, `SODS_*`; `MUK_*`: done |
| length3, Length³ OS, os-length3, OS Length3 Linux, l3 | the crates (`length3-core`, `length3-os`), `LENGTH3_*`, `/etc/length3` and the hostname in ricebox, the releases' names; 1,111 mentions | why where it is the product; ricebox where it is the root; nothing where it is muk's | `why-*`, `WHY_*`; `/etc/ricebox`; `ricebox-0.6.4-…`, `why-0.0.1-…` |
| the core | `why/core`, 15,687 lines, fourteen parts that take from each other in rings | what why says of a repo, its history, Home, a device; with a box run (muk's) and the Remote's client (shipto's) in it | a folder of why to each part; `prompt` the bundle why writes for muk; `compute` gone |
| the web root | `scripts/webroot*.ts`, `public/webroot`, `…-l3-web.tar`; 260 mentions | ricebox as layers | ricebox's layers: read by `module/ricebox/layers` (done), made by it (the scripts still to come) |
| the Remote, remote, shipto | `why/remote`, the core's `remote`, the command's `remote`, `sync`, `git` | what a service wants | `why/shipto`, one folder |
| scripts | `scripts/`, 4,798 lines of every unit's making and checking | each unit's own | in the unit it makes; what checks the whole stays |
| tests | `tests/` | why's, driven as a person drives it | `why/test` |
| runtime, src, test, tests | each unit's folders, named four ways | what runs in a page; the unit itself; its checks | one name each, the same in every unit |
| unit, module | `module/`, `scripts/units.ts` | one thing | module |

## A Prompt is a bundle

One way to start a box, on every host, and no second one:

```
why writes a bundle   →   muk run   →   its terminal, where it has one, to prompt attach
```

| Where | muk | The Linux it asks |
| --- | --- | --- |
| a Linux machine (x86-64) that lets a program make user namespaces | the program beside `why` | the host's kernel |
| a page's Worker, node, a desktop that is not such a machine | the same program, translated as any program of the root is | sods' |

Nothing of why makes a namespace, a mount or a filter, starts a box's program itself, or says a second time what a
Prompt runs with. The bundle is why's whole say in a box, and one function writes it (`prompt/bundle.rs`), for a
page too: the core as wasm, asked through `api` as everything else is.

**What a Prompt's box is**, as its config.json says it:

```
/                   the root, read-only; where the person's dotfiles ask an environment (.packages, .setup), the
                    repo's own root instead, written
/root               the Prompt's home: a directory of the bundle's, the dotfiles written in it, gone with the Prompt
/root/<repo>        the repo (lent)
/var/cache, /var/tmp, /var/log, /root/.cache
                    the repo's caches (lent), freed whenever room is wanted
/tmp, /run          empty, gone with it
/dev, /dev/pts, /proc
                    its own, as muk makes every box's
network             none but its loopback; the host's where the repo was granted it (lent, with the resolver's file)
who                 root of a user namespace of its own, mapped onto the one who runs why
calls               muk's filter: no box asks less
```

A bundle is a directory: `config.json`, `home/`, and with the network `resolv.conf`. On Linux it is
`<data>/prompts/<pid>/`, kept with the Prompt's record and gone with it; on sods it is `/run/box/` in the tree the
kernel is given, with the repo's copy and muk beside it, under the tmpfs the box has at /run.

**What the core's launcher did that muk does not, and where each went.** Nothing is kept beside.

| The launcher (`prompt/launch.rs`, `seccomp.rs`) | Now |
| --- | --- |
| namespaces, mounts, pivot_root, /dev, terminals, the filter | muk's, all of it |
| a pid 1 of its own that reaps and ends what is left with the shell | the kernel's: the box's process is the first of its pid namespace, and every process in it ends with it |
| Ctrl-C passed on to the shell's group by a signal of its own | a terminal's. At a terminal a Prompt has one of its own (muk makes it, `prompt attach` holds its other end) and Ctrl-C is a byte typed; with none, the signal is sent to the box's group, as a terminal sends it. A command run and not a shell (`why prompt REPO -- CMD`) that is interrupted ends its box |
| the terminal's group taken for the shell and given back | never taken: the shell is at a terminal of its own |
| the repo's environment as an overlay over the root, one for all its Prompts by joining a running one's namespaces | a root of the repo's own: a copy of the installed root, made when `.packages` or `.setup` first ask for one (shared blocks where the filesystem has them), lent writable. Any number of Prompts run on it, as on one machine. No overlay, nothing joined; with no ask, the installed root, read-only |
| the host's resolver written into the root | a file of the bundle's, bound where the root looks for it |
| whether this machine lets a Prompt run on the root (a child that makes namespaces) | asked of muk: a bundle whose root holds muk alone, run |
| `compute/` (Firecracker, disks, vsock) | gone; a run's Spec and ledger are `agent/`'s |

**A terminal** is asked for in config.json (`process.terminal`) only where there is one to hold its other end:

| Who starts the Prompt | The box's three descriptors | Ctrl-C |
| --- | --- | --- |
| `why prompt` at a terminal (a person's, an SSH session's, the menu) | a terminal of its own; `prompt attach` between it and the person's | a byte |
| the desktop app, `why prompt REPO -- CMD`, a test | the caller's own (pipes) | the signal, to the box's group |
| a page | the kernel's console, which is the page's screen | the console's (the kernel sends it) |

**What the hosts differ in** is said once, by who lends: the root's place (`<data>/system/<sha256>/root`; `/` of the
tree sods lends), the user root is mapped onto, whether the repo is a directory lent or a copy kept in step
(`mirror.ts`), and where muk is (beside `why`; in the tree at `/run/box/muk` until the root carries it).

## why, inside

why is its parts and its faces. A part is one responsibility, a folder of why holding all of it whatever it is
written in (the Rust the core is compiled of, the TypeScript a page loads); a face holds no judgement, only how a
part is shown and asked. `ls why` is then what why is.

```
why/
  repo/       what a repo is, and what was done in it      store, issues, lines, measure; commits, review, work
  home/       what a person keeps on a device              todo, profile, band, dotfiles, grants, the Agent's key
  prompt/     a repo's box                                 bundle (for muk), running (its record and what it holds),
                                                           kept (its environment and caches), the page's Worker
  agent/      work handed over                             tasks, activity, hands, spec (a run's words and ledger)
  device/     the machine under it                         files, the vault, room and what frees it
  shipto/     what a service wants                         the client (was the core's remote, the command's
                                                           remote, sync, git) and the Remote itself (was why/remote)
  cowboy/     links out of a box and between boxes         below
  text/       why's words, in its two languages            tr!, a title's kind, a name's rule, a diff
  api/        the one door a face asks through             call, answer; the core as wasm
  app/        a face: the window                           pages/, ui/, styles/, main/
  cli/        a face: the words                            words/ (the one table), say/, cmd/
  desktop/    a face: the window on a desktop
  test/       why driven as a person drives it             was tests/
```

What is not why's and was in it:

| It was | It is | Whose |
| --- | --- | --- |
| a box made (`core/src/prompt/launch.rs`, `seccomp.rs`), a machine driven (`core/src/compute`) | gone | muk's |
| a root unpacked, held and made current (`core/src/root/unpack.rs`, `held.rs`, `install.rs`) | `module/ricebox/install` | ricebox's: its own form at rest |
| the layers written (`scripts/webroot*.ts`), the root's programs checked under muk (`scripts/webroot-runnable.ts`, `commands.ts`) | `module/ricebox/make` | ricebox's |
| the layers fetched and kept in a page, which programs are read first and translated ahead (`app/prompt/webroot-fetch.ts`, `first.ts`, `ahead.ts`), the root's tree for a page (`app/prompt/system.ts`) | `module/ricebox/layers` | ricebox's |
| the shell's words and its settings' place (`/etc/length3/shrc`, four copies of what a Prompt's shell is run as) | one, in `prompt/bundle.rs`, until the root says it itself | ricebox's, once a root released from this tree carries it |
| which roots why trusts (`core/src/root/pins.rs`), where one is fetched from | `prompt/roots.rs` | why's: a product's choice of a distribution |

## cowboy

What is on its way: links out of a box and between boxes. Written in Rust, run where the box runs (as wasm in a
page), so that almost all of it is done on the device and what a service is left to do costs next to nothing.

A link is a stream of bytes between two ends, and cowboy is what decides how each is made. It has no packets: a
box's sockets are calls (sods answers them; on Linux the box is in the host's network or in none), so there is no
TCP to run again and no frame to parse on the way. Its unit of work is a byte carried, and its bound is one copy:
from the writer's buffer into a ring both ends hold.

| A link to | Made by | A service does |
| --- | --- | --- |
| a name (DNS) | cowboy answers itself: each name asked for is given an address of cowboy's own, kept beside the name, so a connection is known by the name it was meant for | nothing |
| the box itself, another box on the device | a ring in memory | nothing |
| a box on another device | a channel between the two devices (WebRTC), cowboy at each end | says where each is, once (the Remote) |
| a host that answers a page (HTTP, with CORS) | the page's own request | nothing |
| any other host (TCP: git, SSH, a registry) | one WebSocket to a relay that opens the connection and copies bytes; what is said over it is sealed between the box and the host (TLS, SSH), not read | copies bytes: no judgement, no state past the connection |

So what a service runs for all of it is one relay that copies, and a word of where a device is.

```
module/cowboy/
  src/lib.rs      a link: its two ends, its ring, its state
  src/ring.rs     the bytes on their way
  src/names.rs    names asked and the addresses given them
  src/route.rs    which way a link is made, from what it is to
  src/frame.rs    what goes over a relay: nothing but the bytes, after one line of where to
  test/
```

sods lends a port for it as it lends a tree: what its Linux cannot reach itself (an address that is not the
machine's own) it asks of whoever was given at `linux({net})`, and knows nothing of who answers. ricebox knows
nothing of it. why gives it to a repo granted the network, and shipto runs the relay.

## Today, against that

- **A release is one lump**, named for neither thing it holds: 0.6.4 holds the root, the root as layers, the web
  app and the desktop app as `os-length3-linux-0.6.4-…`. It is to be two: ricebox 0.6.4 (the root, its layers) and
  why 0.0.1 (the app, the command), with `muk` and `sods` beside them.
- **The Linux a browser answers is 9,500 lines of TypeScript** (`module/sods/runtime/linux`): not thin, and far
  from its bound. It is sods' now, and nothing of muk's; the same C muk runs over it.
- **A box is muk's on every host** (above, A Prompt is a bundle): why's core makes none, and its Firecracker
  driver is gone. `muk run` has the floor every box has, held against a config.json that means harm (config.json
  asks, the one who runs muk lends: a path, a namespace, a user, a cgroup of the host's are a box's only by
  `--lend`, `--ids`, `--cgroup`; no capability over the host outside a user namespace; no device but its own; no
  call the filter was not written against) and is checked beside runc and against 255 such config.jsons; it makes
  the box's terminal and gives its other end away. It does not make a filter of config.json's own, or set a
  cgroup's limits itself (they are the lender's, on the cgroup lent).
- **What makes ricebox's layers is not in ricebox**: `scripts/webroot*.ts` write the packs `module/ricebox/layers`
  reads.
- **shipto is in five places**: `why/remote` (8,403 lines), `why/core/src/remote` (2,479), and three of the
  command's files (1,095).

## How far each is from its bound

Measured on one machine (Linux 6.18, a Firecracker guest), 2026-11-11. The bound is counted by hand, or is Linux's
own for the same work.

| Unit | Its work | Today | Bound | Over |
| --- | --- | --- | --- | --- |
| sods' Linux, in a browser | a call, across Workers (getppid) | 1.90 µs | 0.08 µs (Linux) | 24× |
| | write 4 KiB / pread 4 KiB | 2.49 / 2.35 µs | 0.08 / 0.17 µs | 31× / 14× |
| | open+close / stat | 5.74 / 3.03 µs | 0.47 / 0.25 µs | 12× / 12× |
| | the same in turn (one thread) | 0.23 to 1.53 µs | | 2.5× to 6× |
| | fork+exec+wait / posix_spawn | 372 / 567 µs | 174 / 141 µs | 2.1× / 4.0× |
| | `echo \| cat`, 200 times in a shell | 3.9 ms each | | |
| | a root mounted (11,560 files) | 35 to 50 ms | none: an index used where it is | |
| | its tree, written to its bound and not yet what it walks: a path of a whole root | 875 instructions, 74 ns | 430 instructions | 2× |
| sods | a program first translated (git, 680,000 instructions) | 1.29 G instructions (was 1.40 G) | 0.37 G | 3.5× |
| | a small program translated (hello, 3,900 instructions) | 12.4 M (was 20.5 M) | 2.1 M | 5.9× |
| | the code it makes: a call / an indirect call | 3.4 / 6.8 ns | 0.4 / 1.5 ns (native) | 8.5× / 4.5× |
| | fib(20) / setjmp+longjmp | 86.8 µs / 21.5 ns | 15.5 µs / 2.6 ns | 5.6× / 8.3× |
| | `cc hello.c` in a box, 2.83 s | 0.79 s translating, 0.48 s compiling 811 modules | | |
| muk, on Linux | a bundle started (the one `runc spec` writes) | 119 calls, 2.0 ms | 113 calls, 1.9 ms | 1.05× |
| | reading its config.json | 50,000 instructions | 20,000 | 2.5× |
| you | rg, a literal seldom there, a byte | 0.22 instructions (0.78× ripgrep's time, one thread) | 0.16 | 1.4× |
| | rg, a word between its edges, a byte | 0.69 (0.70× ripgrep's) | 0.27 | 2.6× |
| | rg, one of three words, a byte | 0.92 (0.87× ripgrep's) | 0.64 | 1.4× |

## The order

Names first, from the inside out, since a wrong name is paid at every reading; then the furthest from its bound.

1. **The names**, as the table above: length3 in ricebox, then everywhere; the core's parts as why's
   folders; the web root; shipto; each unit's scripts and tests in it.
2. **sods' Linux, in a browser.** The largest, the least thin, and paid on every call. It is one thread's objects behind a
   channel: a call from another Worker is a round trip (1.9 µs), each makes an array and an object and carries its
   arguments as BigInts. To be: its state laid out in one shared memory, each call answered on the thread that makes
   it. First cut: the tree (`lib/tree.h`, written, and what Linux says of every name of a whole root; the calls do
   not walk it yet), then descriptors and pipes, then processes.
3. **sods.** Its files are each one thing now (`module/sods/README.md`), and a walk scans an instruction off its
   own tables, once, however often its function is walked. The foreign decoder is still run once an instruction,
   for the lowering, which is keyed on its types (`operand.rs`, `flags.rs`, `integer.rs`, `sse.rs`, `fpu.rs`: 2,070
   lines) and reads every operand through it. Next cut: an instruction of its own, decoded by tables as the scan
   is, its operands what the lowering asks; then the calls it makes (a call is 8.5× native).
4. **muk on Linux takes the box from why's core.** Done: the filter and the terminal are `muk run`'s, a Prompt
   is a bundle, and the Firecracker driver is gone.
5. **A release per thing**: `muk`, `sods`, ricebox, why 0.0.1. A release of ricebox under its own name (0.0.1)
   holds the root and its layers, and stands on `muk` and `sods` beside it at the boundaries they publish: nothing
   of why is in it or needed by it. It is used as it is taken, so it owes nothing: every input, machine and host
   verified or excluded with its reason, a box made by muk and a terminal held by prompt wherever it runs, sods
   answering the Linux they ask for. `node module/sods/runtime/targets.ts --owed` counts what is owed, and
   `scripts/release.sh` makes no release of that line while the count is not nothing. What is left besides: the
   scripts that write the layers move into `module/ricebox/make`, and `/etc/length3` and the release's names lose
   the old name. Until ricebox is released from this tree, the root a web build takes is the one pinned (0.6.4),
   whose translator is the one before these names.

## How a part is made

The same for each. What it is for in a sentence, and what is not its. Its bytes at rest and on their way laid out
first, since the layout decides the bound. The bound counted by hand for one unit of its work (an instruction
translated, a call answered, a line searched, a bundle started) in instructions, cache lines and system calls.
Written in C on `lib` until callgrind and the disassembly show that sequence. Checked against what it stands in for
over everything there is (Linux, runc, ripgrep, the one before it), byte for byte. Written again in Rust only where
it must be (what runs as wasm beside sods). The one before it deleted in the change that puts it in its place:
nothing kept beside. Its bound stays a test.
