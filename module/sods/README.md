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

```
cargo build --release
sods --trace IN OUT.wasm      # record block entries
sods --whole IN OUT.wasm      # every function, ahead of time
```

Inputs must be static executables linked with `--emit-relocs`; post-linked
release binaries have their relocations removed and are not accepted yet.
Checked natively against the same programs by ricebox's tests
(`sh ../muk/test/programs/run.sh`).
