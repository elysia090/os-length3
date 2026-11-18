# sods — instructions, and where they run

sods translates static x86-64 Linux programs to WebAssembly and provides the
Linux services those programs request. Its current runtime runs in Node.js and
browser Workers, with host-specific operations behind explicit adapters.

The broader goal includes additional instruction sets and hosts, but those are
not all implemented or verified. The [target table](#what-runs-where) distinguishes
supported test coverage from unverified and unimplemented combinations. Native
performance is a design goal, not a general performance guarantee.

## What is sods', and what is not

| Its own | Not its own |
| --- | --- |
| a program made a module: the translator, its form, its ABI (`src/`) | what a box is, and making one: muk (`../muk`, an OCI bundle run) |
| what makes a translation the same translation, and translations kept under it (`src/identity.rs`, `src/cache.rs`, `runtime/translation/kept.ts`) | which programs are translated ahead and shipped: ricebox (`../distribution`), which puts them in its layers |
| the Linux a translated program asks for (`runtime/linux/`) | an image, its layers and their form: ricebox (`../distribution/runtime`); sods lends a tree to mount them in |
| every difference between hosts (`runtime/host.ts`), and the table of what runs where (`runtime/targets.ts`) | a terminal's other end: prompt (`../distribution/terminal`); words, addresses, policy: a product |

## Public interfaces

Three files, and the table. Nothing outside `ricebox/sods` imports anything else of it (`scripts/units.ts` checks
every import in the repository, tests and scripts too), so what sods is made of changes without anyone else's code
changing.

| File | What it gives |
| --- | --- |
| `runtime/translate.ts` | the translator loaded (`loadTranslator`: a program's bytes in, a module's out; `NotAProgram` is the file's fault), a program translated ahead of its run (`aheadOf`), a translation as a Linux here runs it (`prepare`), the form it is kept in (`packMain`, `packMore`, `taken`) and the name it is kept under (`madeBy`) |
| `runtime/linux.ts` | a Linux here (`linux(options)`: its threads apart or in turn, by the host), its tree and the port an image is mounted through (`Vfs`, `mountTarget`, `provide`), translations kept from earlier runs (`keeper`), what a program changed (`Mirror`), a kernel's pause said (`said`), source-bound prepared execution (`captureExecutableSource`, `preparedLinux`) |
| `runtime/host.ts` | the host, asked in one place: which it is, its threads and shared memory, clocks, random bytes, memory and room, a digest, what it keeps, how it fetches |
| `runtime/targets.ts` | what runs where, and how far each is |

From `ricebox/sods`, build the native translator with `cargo build --release`
and run `target/release/sods [--whole] IN.elf OUT.wasm`. For the Wasm translator,
install the `wasm32-unknown-unknown` Rust target and build with
`cargo build --release --target wasm32-unknown-unknown --lib`.
`node runtime/run.ts PROGRAM` is the development runner. These commands are not
additional JavaScript package exports.

## Local JavaScript package

`node ricebox/sods/package/npm.ts NEW_DIRECTORY` emits a private package with four explicit
exports: `sods/translate`, `sods/linux`, `sods/host`, `sods/targets`. `npm pack` in that
directory produces an installable local tarball. Building uses Node 24, not a new
compiler or a registry download. Generated JavaScript includes the CPU Worker entry;
browser applications still need a module-Worker-aware bundler. No ricebox or why is
included. This is not a public registry release.

The caller supplies trusted, integrity-verified translator bytes. Regular file
payloads are owned by the TypeScript Vfs; compiled artifacts do not select another
file-storage engine.

```ts
import {loadTranslator} from 'sods/translate';
import {linux, Vfs} from 'sods/linux';

const translate = await loadTranslator(translatorBytes);
const vfs = new Vfs();
vfs.writeFile('/bin/program', programBytes, 0o755);
const kernel = linux({vfs, translate, inline: true, console: hostConsole});
const status = await kernel.spawn('/bin/program', ['/bin/program'], [], '/');
// status is a Linux wait status, not a decoded exit code.
```

The tree must outlive kernels, mappings, images and delayed readers that use it.
Host persistence is separate from in-memory payload ownership. Guest exit alone
is not evidence that every host operation or Worker has stopped.

The package test extracts the actual tarball and checks its public JavaScript and
Worker dependency closure without Node's TypeScript loader. With a selected
translator fixture, execution checks can exercise real ELF inputs. Node results
do not establish browser execution or current-source artifact compatibility when
a historical translator is selected.

## Source-bound prepared executables

`runtime/linux.ts` additionally exports `captureExecutableSource`,
`preparedLinux` and `PreparedLinuxError`. Existing `linux({translated})` and
byte-bearing file APIs are unchanged. The caller authenticates its release,
source digest, translated artifact and shared-memory preparation mode; origin
and size alone do not prove content identity or translation correctness.

Capture the canonical file before overlays:

```ts
const source = captureExecutableSource(vfs, '/usr/bin/program', {origin, size});
// Ordinary overlays may now replace names without receiving the old image.
const {kernel, attached} = preparedLinux({
  vfs, translate, inline: true, console: hostConsole,
  executables: [{key, source, module: compiledAot, segments, shared: false}],
});
```

A token is opaque and realm-local, not a transferable descriptor or a public
inode. Attachment uses that exact Vfs/inode/revision, never a path relookup.
Changed sources decline and retain ordinary exec fallback. Duplicate keys or
inodes, foreign tokens and malformed admission are rejected before kernel
construction. Execution permissions, credentials and mount restrictions are
still checked by Linux when the program runs. Canonical payloads are not read
merely to attach an image.

Dirty mapping settlement invalidates the file revision **before** any canonical
or alias publication. A failed partial publication, abandonment or retry cannot
revive an old AOT/cache/keeper association. Revision is conservative invalidation
evidence, not a receipt for a completed write. Per-run committed-prefix and alias
ordering remain unchanged.

If attachment fails after construction, `PreparedLinuxError` retains the actual
`kernel` and earlier `attached` images for explicit cleanup. It does not promise
rollback or physical Worker stop. Existing constructor-failure ownership limits
are unchanged. The source/tree owner must still outlive all kernels, mappings,
images and delayed readers. Linux authority and regular payloads remain in the
TypeScript runtime.

## What runs where

`runtime/targets.ts` is the table (`node ricebox/sods/runtime/targets.ts` prints it; a test holds this copy to it).
A state is one of four, never read as another: **verified** (a check of this repository runs it there),
**unverified** (what is made should run there; no check does), **unimplemented** (owed: what it needs is named),
**excluded** (cannot be on that platform: the reason is named, and it is not owed). The order things are made in is
not the goal made smaller: all nine pairs of instruction sets are the goal.

| Input | Runs on | Where | State |
| --- | --- | --- | --- |
| x86-64 | x86-64 | linux | verified: `ricebox/sods/test/programs/run.sh` |
| x86-64 | x86-64 | macos | unverified: the same WebAssembly under node there (host.ts asks node, not the system); no check runs on macos |
| x86-64 | x86-64 | windows | unverified: the same WebAssembly under node there (host.ts asks node, not the system); no check runs on windows |
| x86-64 | x86-64 | browser, worker | verified: `why/test/app/linux.spec.ts` |
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
what sods is for.

**muk runs here.** Every call it makes is answered as Linux answers it (read off muk's own sources and this
kernel's tables by `test/runtime/asks.test.ts`: a call muk comes to make that is not answered fails it), and muk's
own corpus passes with muk on this Linux: `sh test/muk/run.sh BUSYBOX` runs `ricebox/muk/test/muk.sh` and
`hostile.sh` whole inside sods, the same C muk translated, each box made by clone into namespaces, open_tree and
move_mount, pivot_root, its mounts, a terminal of its own and the filter, and saying of itself what it says on
Linux.

**prompt runs here.** `sh test/prompt/run.sh` runs prompt's own check of it (`ricebox/distribution/terminal/test/attach.c`, the
same program as on Linux) inside sods: the same Rust prompt, translated, in front of one terminal this kernel makes
and given another, its signals read as a file (signalfd).

**A box in node is made by muk.** What compares the root's programs here and on Linux (`ricebox/distribution/verification/programs.ts`,
`ricebox/distribution/verification/commands.ts`) runs each in one box, `muk run` of one config.json, made by the same muk on both: 554 of the
root's 555 programs and every line of work say the same (the one apart says which processor it runs on).

**On the implemented execution paths, muk creates the box and prompt or the page supplies its terminal.** In a page's
Worker (`ricebox/distribution/runtime/worker.ts`) and in node, the root's programs run in a box `muk run` makes on
this Linux, of the bundle ricebox writes for every host (`ricebox/distribution/src/bundle.rs`); on a Linux machine the
same bundle is run by the same muk on its kernel (`ricebox/distribution/src/run.rs`), and at a person's
terminal the box has one of its own, its other end held by `prompt attach`. In a page the terminal is the page
itself: this kernel's console, lent to the box by its name (it is the box's /dev/console). `node
ricebox/sods/runtime/targets.ts --owed` lists every line owed (every row above that is not verified or excluded),
and ends 1 while there is one: a release of ricebox under its own name is held to it (`why/build/release.sh`), and is
not made while anything is owed.

The implementation-ownership summary from `targets.ts --one` is:

No box and no terminal is made by anything but muk and prompt.

This describes container creation and native terminal attachment, not host
coverage. Browser console integration remains the page's responsibility.

**What lies past the machine is asked of whoever was given** (`linux({outside})`: `runtime/linux/sys-net.ts`). This
Linux has its loopback and nothing else of its own. A TCP connect or a UDP datagram of the machine's own network
to an address that is not the machine's is handed over: a stream's far end is the outside's to open, refuse, write
to and read from, with the room a stream has; a datagram is its to answer. Who answers is not known here (cowboy
does, `../cowboy`); a box in a network namespace of its own has none, as with the network off.


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
  linux/              the Linux ABI: files and the walk of a path over what is mounted (fs.ts), mounts and their
                      namespaces (mount.ts, sys-mount.ts), who a thread is (cred.ts: ids, capabilities, user
                      namespaces), the other namespaces (space.ts), cgroups (cgroup.ts), processes, threads
                      apart (remote.ts) or in turn, signals, sockets, /proc and /sys, the console and the
                      terminals programs make (pty.ts), the filter (seccomp.ts), what is kept read back (keeper.ts)
lib/tree.h            C on ../lib: every name of a root as Linux says it (written to its bound; the calls do not
                      walk it yet)
test/                 programs/ (each built static, run natively and translated: the same output and status),
                      muk/ and prompt/ (each one's own check, with it on this Linux), runtime/ (the kernel's, node:test),
                      floors/, tree/, cache.rs
examples/             what measures and dumps the translator
```

Code is found from symbols, call targets and the relocations kept by `--emit-relocs` (position-relative jump
tables included); anything reached another way goes through an address dispatcher. Guest addresses are wasm
addresses, registers are locals, flags are deferred so `cmp`+`jcc` is one comparison, `rep movs` is `memory.copy`
(an element at a time only where it copies onto what it has still to read, as x86 does), the direction flag is the
thread's own. Inputs must be static executables linked with `--emit-relocs`; post-linked release binaries have
their relocations removed and are not accepted yet.

Run the following from `ricebox/sods`; the shell fixtures require their native
build tools and artifacts as documented in each script.

```sh
sh test/programs/run.sh                          every test program, native beside translated
sh test/muk/run.sh BUSYBOX                       muk's own corpus, with muk on this Linux (a static busybox its shell)
sh test/prompt/run.sh                            prompt's own check, with prompt on this Linux
cargo test --locked --release                    the translator's own, the identity's and the cache's
node --test --test-concurrency=3 test/runtime/*.test.ts
SODS_INLINE=1 node runtime/run.ts PROGRAM        its threads in turn on one thread, not each in a Worker
SODS_SYSCALLS=1 SODS_FAULTS=1 SODS_TIMING=1 node runtime/run.ts PROGRAM
# Optional syscall, fault and timing diagnostics.
```

### Runtime tests

The development runner reads its default artifacts under `CARGO_TARGET_DIR`
(or `ricebox/sods/target/`). `SODS_NATIVE` and `SODS_TRANSLATOR_WASM` can
select artifacts explicitly. `SODS_BLOCKS` and `SODS_RUN` require the native
translator, because their trace and run-cut options are not part of the Wasm
translator's API. The runner caches complete modules by translator digest
under its Cargo target directory. A concurrent run does not delete another
translator's cache.

The runtime tests can run without a guest root. Build the translator and the
native fixtures with `test/programs/run.sh` for the executable integration
cases. To use translators built in another directory, set `SODS_NATIVE`,
`SODS_TRANSLATOR_WASM`, and `SODS_CURRENT_TRANSLATOR_WASM` to the matching files.
The last variable explicitly opts in to assertions about the current source.

BusyBox integration tests need an ELF, its whole-program translation, and
the translator that prepared the release. Run the following from the
repository root with a prepared web root and a new output directory:

```sh
node ricebox/distribution/verification/test/fixtures/stage-sods-userland.ts WEB_ROOT target/sods-release-fixture
SODS_TEST_USERLAND_DIR=target/sods-release-fixture node --test --test-concurrency=3 ricebox/sods/test/runtime/*.test.ts
```

An explicitly selected fixture must contain `busybox`, `busybox.wasm`, and
`sods.wasm`. Omit the variable to run without the BusyBox-dependent cases.
Building a web root does not prepare or select a test fixture.

### Arithmetic flags across calls

Calls preserve the callee's actual CF/PF/AF/ZF/SF/OF result, including flags the
callee leaves unchanged. Unknown callees and nonlocal returns retain all six;
a normal continuation's needs alone are not sufficient when a guest changes a
return address. A transitive quiet function that neither reads nor modifies any
of these flags leaves their shared state untouched. Its caller can keep flags in
locals on normal return, publishing them only if it returns somewhere else.
This proof excludes unknown calls, traps, loops, recursion and external jumps.

A nontransparent quiet callee is handed its exact entry's input demand, not the union
loaded for all entries of its function. It still publishes all six flags on return.
A caller takes back only the flags its normal continuation needs, after the nonlocal
return branch has retained the full published state. At ordinary CFG boundaries,
held flags cover the union of local and external successor demand. Instruction-internal
partial updates and quiet-call nonlocal publication retain full holding. A deferred
CMP difference is shared only when several demanded formulas use it; a conditional
save cannot establish that difference on the path that skipped the save.

The optimization avoids unconditional packing at every known quiet call. For the
same 64-call, flags-unused ELF, generated function bodies were 4,650 bytes before
this correction, 11,085 with unconditional preservation, and 4,650 with the quiet
proof. A flags-observing indirect-call fixture still grows from 999 to 1,144 body
bytes. These include helpers/locals and are code-size observations, not a general
runtime speed claim or a lower-bound proof.

AF occupies bit 5 of the packed `G_FLAGS` convention; bits 0–4 and the global
index are unchanged. Main and additional modules and host signal conversion must
use the same convention. Rebuild content-addressed translations after a translator
change: structural Wasm compatibility is not proof of matching flag semantics.
The current-source call regression covers direct/indirect, whole/incremental,
partial updates, AF and a verified depth unwind. This is not a complete proof of
all x86 flag-producing instructions or every syscall-resume path.

`branch-counter-current.test.ts` separately checks JRCXZ/JECXZ counter width,
taken and fallthrough paths, unchanged counter/flags, and CMP/TEST immediately
before these branches without flag-condition fusion. The depth-unwind fixture
continues to use DEC/JZ so its acceptance does not depend on this instruction.
LOOP/LOOPE/LOOPNE lowering remains a separate gate, not covered by these checks.

For the same pinned root 0.6.5 ELF inputs, whole-translation gzip level 9 is now
2,891,098 bytes for bash and 1,714,641 for BusyBox, 99,666 fewer bytes in total than
the published full-preservation correction. Native and Wasm translators produced
byte-identical modules. These are artifact-size measurements, not a passed browser
cold-start budget or a runtime speed claim. Input identities and the broader
ownership/compatibility gates are recorded in [the runtime contract](../../docs/runtime-foundation.md).

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
| no Linux under it | `runtime/linux/`, answering its calls | done in a browser and in node, in TypeScript and far from its bound, for what a program asks and for what a box's maker asks: namespaces of every kind but time's, mounts and how they spread, users and capabilities, cgroups that count processes, terminals, the filter (muk's corpus passes on it) |
| which host this is (a page, a Worker, node) | `runtime/host.ts` | asked in one place: node or not, its threads, shared memory, running apart, waiting, processors, what was said from outside |
| a host's clocks | `runtime/host.ts` (`steady`, `began`, `epoch`) | asked in one place: the Linux here reads none of the host's own (a test reads its sources for them) |
| a host's random bytes | `runtime/host.ts` (`random`) | asked in one place: `getrandom` and `AT_RANDOM`, `/dev/urandom`, the UUIDs `/proc` says all draw there |
| where bytes are kept, how they are fetched, their digest | `runtime/host.ts` (`kept`, `range`, `rangeNow`, `sha256`) | asked in one place: a browser's Cache Storage, its Range requests (waited for, or had inside a call in a Worker) and its SHA-256; a host with no store keeps nothing and says so |
| a program for another machine (ARM64, RISC-V) | nothing yet | `src/` reads x86-64 alone; the table above says so for each pair |
| a host of another system (macOS, Windows), natively | nothing yet | the same wasm under an engine there, `host.ts` answering for it; not checked, and without an engine not begun |
| no system at all | nothing yet | not begun |

## Its counts

These historical implementation-ledger estimates are not proved specification lower bounds;
[the runtime contract](../../docs/runtime-foundation.md) separates required work from interface-imposed copies and measurements.

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
