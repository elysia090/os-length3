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
  descriptors and pipes, fork/exec/wait, threads, signals and an exact
  80-bit x87. Processes run at once, as on Linux: fork returns in the
  parent at once; a call that must wait (input not typed yet, a child
  still running, a full pipe) leaves its thread waiting, and the kernel
  makes it again when something changed. Threads (clone with CLONE_VM)
  share their process's memory, with futexes, robust lists and a tid
  cleared at exit. Signals reach handlers through an rt_sigframe that
  rt_sigreturn reads back (masks, SA_SIGINFO, SA_RESTART, sigaltstack);
  pipes hold 64 KiB in pages as Linux's do, and a full one makes its
  writer wait. Threads run here one at a time (each until it waits, or
  for a time slice taken at its calls), or each in its own Worker with
  memory shared, when the host allows SharedArrayBuffer
  (`runtime/remote.mjs`).
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
