# sods — instructions, and where they run

What takes the dull boundaries away: a program is built once, for one machine and one kernel, and sods makes it
run where there is no such machine, no such kernel, or no system at all, as fast as the machine it lands on runs
anything. Hosts (Linux, macOS, Windows), the Web (a page, a Worker), bare metal and the instruction sets
(x86-64, ARM64, RISC-V) differ; sods is where they differ, so that muk, prompt, ricebox and a product hold no
decision made by where a program runs ([#191](https://github.com/elysia090/os-length3/issues/191)).

Today it is one way across those boundaries: a static x86-64 Linux program made WebAssembly ahead of its run, and
the Linux that program asks for answered beside it, in a browser's page, its Workers and node. The browser used to
run Linux by emulating a whole PC (guest kernel, MMU, interrupts, a runtime x86→wasm JIT); sods removes the machine
instead. Rust; where the bound is not reached in plain Rust, C on `../lib` beside it.

## What is sods', and what is not

| Its own | Not its own |
| --- | --- |
| a program made a module: the translator, its form, its ABI (`src/`) | what a box is, and making one: muk (`../muk`, an OCI bundle run) |
| what makes a translation the same translation, and translations kept under it (`src/identity.rs`, `src/cache.rs`, `runtime/translation/kept.ts`) | which programs are translated ahead and shipped: ricebox (`../ricebox`), which puts them in its layers |
| the Linux a translated program asks for (`runtime/linux/`) | an image, its layers and their form: ricebox (`../ricebox/layers`); sods lends a tree to mount them in |
| every difference between hosts (`runtime/host.ts`), and the table of what runs where (`runtime/targets.ts`) | a terminal's other end: prompt (`../prompt`); words, addresses, policy: a product |

## How others take it

Three files, and the table. Nothing outside `module/sods` imports anything else of it (`scripts/units.ts` checks
every import in the repository, tests and scripts too), so what sods is made of changes without anyone else's code
changing.

| File | What it gives |
| --- | --- |
| `runtime/translate.ts` | the translator loaded (`loadTranslator`: a program's bytes in, a module's out; `NotAProgram` is the file's fault), a program translated ahead of its run (`aheadOf`), a translation as a Linux here runs it (`prepare`), the form it is kept in (`packMain`, `packMore`, `taken`) and the name it is kept under (`madeBy`) |
| `runtime/linux.ts` | a Linux here (`linux(options)`: its threads apart or in turn, by the host), its tree and the port an image is mounted through (`Vfs`, `mountTarget`, `provide`), translations kept from earlier runs (`keeper`), what a program changed (`Mirror`), a kernel's pause said (`said`) |
| `runtime/host.ts` | the host, asked in one place: which it is, its threads and shared memory, clocks, random bytes, memory and room, a digest, what it keeps, how it fetches |
| `runtime/targets.ts` | what runs where, and how far each is |

Besides those: `sods` the program (`cargo build --release`: `sods [--whole] IN.elf OUT.wasm`), the same translator
as a module (`--target wasm32-unknown-unknown --lib`, byte-identical output), and `node runtime/run.ts PROGRAM`,
which runs a program on node as a page runs it.

## What runs where

`runtime/targets.ts` is the table (`node module/sods/runtime/targets.ts` prints it; a test holds this copy to it).
A state is one of four, never read as another: **verified** (a check of this repository runs it there),
**unverified** (what is made should run there; no check does), **unimplemented** (owed: what it needs is named),
**excluded** (cannot be on that platform: the reason is named, and it is not owed). The order things are made in is
not the goal made smaller: all nine pairs of instruction sets are the goal.

| Input | Runs on | Where | State |
| --- | --- | --- | --- |
| x86-64 | x86-64 | linux | verified: `module/sods/test/programs/run.sh` |
| x86-64 | x86-64 | macos | unverified: the same WebAssembly under node there (host.ts asks node, not the system); no check runs on macos |
| x86-64 | x86-64 | windows | unverified: the same WebAssembly under node there (host.ts asks node, not the system); no check runs on windows |
| x86-64 | x86-64 | browser, worker | verified: `tests/app/linux.spec.ts` |
| x86-64 | x86-64 | bare | unimplemented: a host with no system under it: host.ts answers for a page, a Worker and node |
| x86-64 | arm64 | linux, macos, windows | unverified: the same WebAssembly under node there; no check runs on arm64 |
| x86-64 | arm64 | browser, worker | unverified: the same WebAssembly under a browser there; no check runs on arm64 |
| x86-64 | arm64 | bare | unimplemented: a host with no system under it: host.ts answers for a page, a Worker and node |
| x86-64 | riscv64 | linux | unverified: the same WebAssembly under node there; no check runs on riscv64 |
| x86-64 | riscv64 | macos | excluded: macOS runs on no RISC-V machine |
| x86-64 | riscv64 | windows | excluded: Windows is released for no RISC-V machine |
| x86-64 | riscv64 | browser, worker | unverified: the same WebAssembly under a browser there; no check runs on riscv64 |
| x86-64 | riscv64 | bare | unimplemented: a host with no system under it: host.ts answers for a page, a Worker and node |
| arm64 | x86-64 | linux, macos, windows, browser, worker, bare | unimplemented: a translator for arm64 programs: src/ reads x86-64 (elf.rs refuses another machine's) |
| arm64 | arm64 | linux, macos, windows, browser, worker, bare | unimplemented: a translator for arm64 programs: src/ reads x86-64 (elf.rs refuses another machine's) |
| arm64 | riscv64 | linux, browser, worker, bare | unimplemented: a translator for arm64 programs: src/ reads x86-64 (elf.rs refuses another machine's) |
| arm64 | riscv64 | macos | excluded: macOS runs on no RISC-V machine |
| arm64 | riscv64 | windows | excluded: Windows is released for no RISC-V machine |
| riscv64 | x86-64 | linux, macos, windows, browser, worker, bare | unimplemented: a translator for riscv64 programs: src/ reads x86-64 (elf.rs refuses another machine's) |
| riscv64 | arm64 | linux, macos, windows, browser, worker, bare | unimplemented: a translator for riscv64 programs: src/ reads x86-64 (elf.rs refuses another machine's) |
| riscv64 | riscv64 | linux, browser, worker, bare | unimplemented: a translator for riscv64 programs: src/ reads x86-64 (elf.rs refuses another machine's) |
| riscv64 | riscv64 | macos | excluded: macOS runs on no RISC-V machine |
| riscv64 | riscv64 | windows | excluded: Windows is released for no RISC-V machine |

## One implementation each

muk is the C that makes a box, and prompt the Rust at a terminal's other end, on every host: where there is no
Linux under them, the Linux they ask for is answered here, and nothing is written a second time for a host. That is
what sods is for, and it is not so yet. What stands in the way is counted, not described: the calls muk makes that
this Linux does not answer (read off muk's own sources and this kernel's tables by `test/runtime/asks.test.ts`, so
a call answered is struck and a call muk comes to make is added), and where a box or a terminal is still made by
something else. `node module/sods/runtime/targets.ts --owed` lists every line owed, these and every row above that
is not verified or excluded, and ends 1 while there is one: a release of ricebox under its own name is held to it
(`scripts/release.sh`), and is not made while anything is owed.

| Call muk makes | Here | What it needs |
| --- | --- | --- |
| clone (56) | refused | a process made in namespaces of its own (CLONE_NEWNS, NEWPID, NEWUSER, NEWUTS, NEWIPC, NEWNET, NEWCGROUP): EPERM today |
| setgroups (116) | refused | groups set by one whose user namespace lets it (its gid_map written, setgroups not denied): EPERM always today |
| pivot_root (155) | refused | a root of its own for a mount namespace: paths are walked from one root today |
| mount (165) | refused | proc, sysfs, tmpfs, devpts, mqueue and cgroup2 mounted, a bind, a remount with its flags, how a mount spreads |
| umount2 (166) | refused | a mount taken away (MNT_DETACH: the old root, after pivot_root) |
| unshare (272) | absent | a cgroup namespace begun where the process is |
| setns (308) | refused | a namespace joined by its descriptor (/proc/PID/ns/*): EPERM today |
| open_tree (428) | absent | what is mounted at a path, or a copy of it, as a descriptor |
| move_mount (429) | absent | such a descriptor put on a path |
| clone3 (435) | refused | a process made in a cgroup that was lent (CLONE_INTO_CGROUP): ENOSYS today |
| openat2 (437) | absent | a path opened that leads nowhere out of where it starts (RESOLVE_BENEATH) |
| mount_setattr (442) | absent | a mount's flags and how it spreads, set on its descriptor |

| What is made | By, today | What ends that |
| --- | --- | --- |
| a box where there is no Linux (a page, a Worker, node) | the caller starts its program directly on this Linux (linux.ts linux(): why/app/host/prompt/kernel.worker.ts, scripts/webroot-runnable.ts) | the calls owed above answered, and a terminal made in a /dev/pts of the box (ptmx, its pair, TIOCGPTPEER); then `muk run` of a bundle here, checked by muk's own corpus (module/muk/test/muk.sh, hostile.sh) with muk on this Linux |
| a box on the desktop (Linux) | why's core makes it itself (why/core/src/prompt/launch.rs, seccomp.rs; why/core/src/compute) | the launcher runs `muk run` on a bundle it writes, and its own making of a box goes |
| a terminal where there is no Linux | the page's own console (why/app/host/prompt/kernel.worker.ts, why/app/prompt) | signalfd answered here, and the terminal muk gives away taken by `prompt attach` on this Linux, checked by module/prompt/test/prompt.sh there |
| a terminal on the desktop (Linux) | why's core's session (why/core/src/prompt) | the session hands the descriptor muk sends to `prompt attach` |

What muk asks and is answered as Linux answers it is checked beside Linux: the filter muk puts over every box, by
muk's own check of it and by `test/programs/seccomp.c`, the same natively and here.

## Its folders

```
src/                  the translator (Rust), one direction, each file one thing (src/lib.rs lists them):
                      elf → x86, scan → find, program, layout → facts → frame, sync → operand, flags, integer,
                      sse, fpu → lower → image; abi (what the code and what runs it agree on); wasm; x87 (the
                      exact 80-bit coprocessor, in the translator's wasm); web (its exports as a module);
                      identity (a translation's key) and cache (translations kept under it, on a host with files)
runtime/              what runs beside a translated program
  translate.ts        entry: translation
  linux.ts            entry: a Linux here
  host.ts             entry: the host
  targets.ts          entry: what runs where
  run.ts              node runtime/run.ts [--root DIR] [--cwd DIR] [--tty] PROGRAM [args...]
  translation/        the translator's wrapper, the x87's, a translation shared between Workers (share.ts),
                      translated ahead (ahead.ts), kept between runs (kept.ts)
  linux/              the Linux ABI: files, processes, threads apart (remote.ts) or in turn, signals, sockets,
                      /proc, a terminal, what is kept read back (keeper.ts)
lib/tree.h            C on ../lib: every name of a root as Linux says it (written to its bound; the calls do not
                      walk it yet)
test/                 programs/ (each built static, run natively and translated: the same output and status),
                      runtime/ (the kernel's, node:test), floors/, tree/, cache.rs
examples/             what measures and dumps the translator
```

Code is found from symbols, call targets and the relocations kept by `--emit-relocs` (position-relative jump
tables included); anything reached another way goes through an address dispatcher. Guest addresses are wasm
addresses, registers are locals, flags are deferred so `cmp`+`jcc` is one comparison, `rep movs` is `memory.copy`
(an element at a time only where it copies onto what it has still to read, as x86 does), the direction flag is the
thread's own. Inputs must be static executables linked with `--emit-relocs`; post-linked release binaries have
their relocations removed and are not accepted yet.

```
sh test/programs/run.sh                          every test program, native beside translated
cargo test --locked --release                    the translator's own, the identity's and the cache's
SODS_INLINE=1 node runtime/run.ts PROGRAM        its threads in turn on one thread, not each in a Worker
SODS_SYSCALLS=1, SODS_FAULTS=1, SODS_TIMING=1    every call listed; each fault said; where the time went
```

## A translation kept

A translation is good for exactly what made it: the program's bytes, the translator's, the ABI between the code
and what runs it, and every option that changes the output. `src/identity.rs` makes one key of those
(`identity::Key`), and nothing is ever invalidated in place: what changes, changes the key. `src/cache.rs` keeps
translations under that key on a host with files (a directory private to one user, an entry published whole or not
at all, built once across threads and processes). In a browser the same rule is `madeBy` (`runtime/translate.ts`):
a copy is kept under the translator that made it and whether its memory is shared, and one kept under another name
is never read. Which programs are translated ahead and shipped is not sods' to say: ricebox puts them in its
layers, named by the translator's digest.

## The boundaries, and which are taken on

| The boundary | Who takes it on | Where it stands |
| --- | --- | --- |
| no x86-64 under the program | `src/`: the program made WebAssembly ahead of the run | done for static Linux programs; the lowering still reads its operands through a decoder that is not sods' |
| no Linux under it | `runtime/linux/`, answering its calls | done in a browser and in node, in TypeScript and far from its bound, for what a program asks; of what a box's maker asks, the filter is answered and the namespaces and mounts are owed (above) |
| which host this is (a page, a Worker, node) | `runtime/host.ts` | asked in one place: node or not, its threads, shared memory, running apart, waiting, processors, what was said from outside |
| a host's clocks | `runtime/host.ts` (`steady`, `began`, `epoch`) | asked in one place: the Linux here reads none of the host's own (a test reads its sources for them) |
| a host's random bytes | `runtime/host.ts` (`random`) | asked in one place: `getrandom` and `AT_RANDOM`, `/dev/urandom`, the UUIDs `/proc` says all draw there |
| where bytes are kept, how they are fetched, their digest | `runtime/host.ts` (`kept`, `range`, `rangeNow`, `sha256`) | asked in one place: a browser's Cache Storage, its Range requests (waited for, or had inside a call in a Worker) and its SHA-256; a host with no store keeps nothing and says so |
| a program for another machine (ARM64, RISC-V) | nothing yet | `src/` reads x86-64 alone; the table above says so for each pair |
| a host of another system (macOS, Windows), natively | nothing yet | the same wasm under an engine there, `host.ts` answering for it; not checked, and without an engine not begun |
| no system at all | nothing yet | not begun |

## Its counts

A program made a module, in the translator's own instructions (callgrind, one machine, 2026-11-11). By hand, an
x86 instruction is about 550: scanned once, decoded once, its block and its function laid out, the 30 bytes of
wasm it comes to written, and what the whole program decides shared out.

| | 2026-11-11, morning | now | by hand |
| --- | --- | --- | --- |
| busybox whole (141,000 instructions) | 333 M | 301 M | 77 M |
| git, as it first runs (680,000) | 1.40 G | 1.29 G | 0.37 G |
| hello (3,900) | 20.5 M | 12.4 M | 2.1 M |
| allocations, busybox whole | 61,500 | 29,600 | a few hundred |

Where busybox's 301 M are, most first:

| part | instructions | what is over |
| --- | --- | --- |
| a walk (`find.rs`, `scan.rs`) | 57 M | 290 for each instruction walked: two passes over a function, each asking the map and the marks again |
| what each instruction means (`operand.rs` … `sse.rs`) | 52 M | every operand read through the decoder's instruction: a register's number and width looked up at each use |
| a function's control flow (`lower.rs`) | 39 M | 940 a block |
| its syncs and its bytes onto the module (`sync.rs`, `lower.rs`) | 29 M | each sync's place copied round, 60,000 pieces |
| the layout (`layout.rs`) | 22 M | 530 a block; twenty lists cleared for each function |
| finding, between walks (`find.rs`) | 20 M | sets and maps by address, where the code is one stretch |
| the decoder (iced), for the lowering | 19 M | a whole instruction built to read a few fields of it |
| the facts (`facts.rs`) | 17 M | functions decoded a third time for what registers they touch |
| copying, allocating, sorting | 33 M | |

What has gone since the morning: an instruction decoded again each time its function was walked again (a third of
all walking; now 16 bits kept by its address); the decoder in the walk at all (`scan.rs`: tables, checked against
it over every opcode); two tables made whole at the first instruction of every process (7.8 M, most of a small
program's translation); half the allocations; every reference sorted again at each round of finding. What it makes
is the same to the byte throughout (174 modules of 39 programs compared at each step), but for a function whose
symbol has no name, now shown as any with none.

Next, in the order of what is over: the lowering on an instruction of sods' own (operands already what the
lowering asks: a register's number and part, a memory operand's terms), decoded by tables as the scan is, so the
foreign decoder and its tables go from what a page loads; then a walk in one pass; then the layout and the syncs
on lists that are not cleared.
