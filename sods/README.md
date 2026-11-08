# sods — instructions

Static x86-64 Linux programs made WebAssembly ahead of the run. The browser
used to run Linux by emulating a whole PC (guest kernel, MMU, interrupts, a
runtime x86→wasm JIT); sods removes the machine instead, and the kernel that
runs what it makes is ricebox's (`../ricebox`).

- `src/` (Rust) translates a static x86-64 ELF ahead of time into one wasm
  module. Guest addresses are wasm addresses, registers are locals, flags
  are deferred so `cmp`+`jcc` is one comparison, `rep movs` is
  `memory.copy`. Code is found from symbols, call targets and the
  relocations kept by `--emit-relocs` (including position-relative jump
  tables); anything reached another way goes through an address dispatcher.
- The translator also builds as wasm (`--target wasm32-unknown-unknown
  --lib`, wrapped by `runtime/translator.ts`) and gives byte-identical
  output, so a browser translates the programs it runs.
- `runtime/` holds what of it runs beside the program: the translator's
  wrapper, a translation shared between Workers (`share.ts`), programs
  translated ahead while a Prompt waits (`ahead.ts`) and the exact 80-bit x87
  (`fpu.ts`).

```
cargo build --release
xlat --trace IN OUT.wasm      # record block entries
xlat --whole IN OUT.wasm      # every function, ahead of time
```

Inputs must be static executables linked with `--emit-relocs`; post-linked
release binaries have their relocations removed and are not accepted yet.
Checked natively against the same programs by ricebox's tests
(`sh ../ricebox/tests/run.sh`).
