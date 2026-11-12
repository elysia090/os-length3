# sods — instructions, and where they run

What takes the dull boundaries away: a program is built once (x86-64, for Linux) and sods makes it run where there
is no such machine and no such kernel under it (a browser, with what a browser allows; a host of another system; no
system at all), as fast as the machine it lands on runs anything. Code under it is the same code everywhere. Rust;
where the bound is not reached in plain Rust, C on `../lib` beside it.

Today it is one way across one of those boundaries: static x86-64 Linux programs made WebAssembly ahead of the run. The browser
used to run Linux by emulating a whole PC (guest kernel, MMU, interrupts, a
runtime x86→wasm JIT); sods removes the machine instead, and the kernel that
runs what it makes is ricebox's (`../ricebox`).

- `src/` (Rust) translates a static x86-64 ELF ahead of time into one wasm
  module. Guest addresses are wasm addresses, registers are locals, flags
  are deferred so `cmp`+`jcc` is one comparison, `rep movs` is
  `memory.copy`. Code is found from symbols, call targets and the
  relocations kept by `--emit-relocs` (including position-relative jump
  tables); anything reached another way goes through an address dispatcher.
  In one direction, each file one thing: `elf.rs` the program at rest; `x86.rs` an instruction as sods reads it
  (the decoder is taken in there and nowhere else) and `scan.rs` what a walk needs of one, read off tables made
  ahead (`scan_table.rs`, by `examples/scan_table.rs`); `find.rs` finds the code into a `program.rs`, its blocks in
  the order `layout.rs` gives them; `facts.rs` decides what the whole program shares (the flags each entry
  reads, what a call may touch); `frame.rs` is a function as it is made (its locals, its bytes, its labels) and
  `sync.rs` which registers it moves to their globals; `operand.rs`, `flags.rs`, `integer.rs`, `sse.rs` and
  `fpu.rs` are what each instruction means on it; `lower.rs` its control flow; `image.rs` the module around
  the code. `abi.rs` is what the code and what runs it agree on; `wasm.rs` WebAssembly as bytes.
- The translator also builds as wasm (`--target wasm32-unknown-unknown
  --lib`; `src/web.rs` is what it exports there, wrapped by `runtime/translator.ts`) and gives byte-identical
  output, so a browser translates the programs it runs.
- The exact 80-bit x87 is Rust too (`src/x87.rs`), in the translator's wasm:
  an instance of that module of its own holds each thread's registers, and
  translated code calls it wasm to wasm, its memory operands loaded and
  stored by the translated code itself (`runtime/x87.ts`).
- `runtime/` holds what of it runs beside the program: the translator's
  wrapper, the x87's, a translation shared between Workers (`share.ts`),
  programs translated ahead while a Prompt waits (`ahead.ts`), and the form a
  translation is kept in between runs (`kept.ts`; muk keeps the copies).
- **`runtime/host.ts` is the host, asked in one place.** The same code runs in
  a browser's page, in one of its Workers and in node, and what differs
  between them is answered there and nowhere else: whether this is node, what
  was said to it from outside, its own modules where it has them, its
  threads, how many processors it has, whether memory is shared between
  threads, whether they may run apart on it (in a browser, only a page set
  apart from other origins'), whether this thread may wait, its clocks
  (`steady`, `began`, `epoch`) and its random bytes (`random`). muk's runtime
  and the translator's wrapper asked each of these for themselves, in eight
  files, each its own way; they ask here now, and a host that is neither
  (another system's, none at all) is one file's to take on. What it does not
  hold yet is below.

```
cargo build --release
sods --trace IN OUT.wasm      # record block entries
sods --whole IN OUT.wasm      # every function, ahead of time
```

Inputs must be static executables linked with `--emit-relocs`; post-linked
release binaries have their relocations removed and are not accepted yet.
Checked natively against the same programs by ricebox's tests
(`sh ../muk/test/programs/run.sh`).

## The boundaries, and which are taken on

| The boundary | Who takes it on | Where it stands |
| --- | --- | --- |
| no x86-64 under the program | `src/`: the program made WebAssembly ahead of the run | done for static Linux programs; the lowering still reads its operands through a decoder that is not sods' |
| no Linux under it | muk's `runtime/`, answering its calls | done in a browser and in node, in TypeScript and far from its bound |
| which host this is (a page, a Worker, node) | `runtime/host.ts` | asked in one place: node or not, its threads, shared memory, running apart, waiting, processors, what was said from outside |
| a host's clocks | `runtime/host.ts` (`steady`, `began`, `epoch`) | asked in one place: muk's runtime reads none of the host's own (a test reads its sources for them); the floors the same within their noise |
| a host's random bytes | `runtime/host.ts` (`random`) | asked in one place: `getrandom` and `AT_RANDOM`, `/dev/urandom`, the UUIDs `/proc` says (made of them by muk) all draw there; the same test reads muk's sources for the host's own |
| where bytes are kept, how they are fetched, their digest | `runtime/host.ts` (`kept`, `range`, `rangeNow`, `sha256`) | asked in one place: a browser's Cache Storage, its Range requests (waited for, or had inside a call in a Worker) and its SHA-256; a host with no store keeps nothing and says so; the same test reads muk's sources for `caches`, `fetch`, `XMLHttpRequest`, `crypto.subtle` and `navigator` |
| a host of another system (macOS, Windows), natively | nothing yet | the same wasm under an engine there, `host.ts` answering for it; not begun |
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
