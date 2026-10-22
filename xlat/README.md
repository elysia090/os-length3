# xlat — static x86-64 Linux programs as WebAssembly

The browser used to run Linux by emulating a whole PC (guest kernel, MMU,
interrupts, a runtime x86→wasm JIT). xlat removes the machine instead:

- `src/` (Rust) translates a static x86-64 ELF ahead of time into one wasm
  module. Guest addresses are wasm addresses, registers are locals, flags
  are deferred so `cmp`+`jcc` is one comparison, `rep movs` is
  `memory.copy`. Code is found from symbols, call targets and the
  relocations kept by `--emit-relocs` (including position-relative jump
  tables); anything reached another way goes through an address dispatcher.
- `runtime/` (JS) is the user-mode kernel: processes, a POSIX tree, file
  descriptors and pipes, fork/exec/wait, and an exact 80-bit x87. System
  calls are restartable: one that must wait (input not typed yet, a child
  still running) unwinds and later re-executes the same `syscall`
  instruction, so nothing blocks and no shared memory is needed. fork
  makes the child the running process; the parent's fork returns once it
  has exited.
- The translator also builds as wasm (`--target wasm32-unknown-unknown
  --lib`, wrapped by `runtime/translator.mjs`) and gives byte-identical
  output, so a browser translates the programs it runs.
- The programs a Prompt runs are the release root's own (os/scripts/l3.mjs
  makes l3 for the browser from it); `os/scripts/l3-runnable.mjs` says which
  of them run under xlat today, against the same root run natively.

```
cargo build --release
node runtime/run.mjs PROGRAM [args...]            # host ELF as /bin/PROGRAM
node runtime/run.mjs --root DIR /bin/sh -c '...'  # a host tree as /
sh tests/run.sh                                    # native vs translated
xlat --trace IN OUT.wasm                           # record block entries
```

Inputs must be static executables linked with `--emit-relocs`; post-linked
release binaries have their relocations removed and are not accepted yet.
