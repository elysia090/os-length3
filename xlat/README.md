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
  descriptors and pipes, fork/exec/wait, and an exact 80-bit x87.
  Processes run to completion one at a time: fork copies memory and runs
  the child inside the parent's fork call.

```
cargo build --release
node runtime/run.mjs PROGRAM [args...]            # host ELF as /bin/PROGRAM
node runtime/run.mjs --root DIR /bin/sh -c '...'  # a host tree as /
sh tests/run.sh                                    # native vs translated
xlat --trace IN OUT.wasm                           # record block entries
```

Inputs must be static executables linked with `--emit-relocs`; post-linked
release binaries have their relocations removed and are not accepted yet.
