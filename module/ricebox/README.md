# ricebox — the box

The smallest UNIX a browser runs, and the box it runs in. `runtime/` is the
user-mode kernel (TypeScript, for now): processes, a POSIX tree, file
descriptors and pipes, fork/exec/wait, threads, signals.

- Processes run at once, as on Linux: fork returns in the parent at once; a
  call that must wait (input not typed yet, a child still running, a full
  pipe) leaves its thread waiting, and the kernel makes it again when
  something changed.
- Threads (clone with CLONE_VM) share their process's memory, with futexes,
  robust lists and a tid cleared at exit.
- Signals reach handlers through an rt_sigframe that rt_sigreturn reads back
  (masks, SA_SIGINFO, SA_RESTART, sigaltstack).
- Pipes hold 64 KiB in pages as Linux's do, and a full one makes its writer
  wait.
- Threads run here one at a time (each until it waits, or for a time slice
  taken at its calls), or each in its own Worker with memory shared, when the
  host allows SharedArrayBuffer (`runtime/remote.ts`). There a write to the
  console, as a read of the clock, is done in the thread's own Worker (into an
  outbox the kernel takes from, `runtime/channel.ts`), not asked of the kernel
  a line at a time.

The code it runs is sods' (`../sods`); what it reads at rest is muk's
(`../muk`).

```
node runtime/run.ts PROGRAM [args...]            # host ELF as /bin/PROGRAM
node runtime/run.ts --root DIR /bin/sh -c '...'  # a host tree as /
sh tests/run.sh                                   # native vs translated, and the unit tests
node tests/floors/floors.ts                       # each floor beside Linux
```
