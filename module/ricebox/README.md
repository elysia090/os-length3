# ricebox — the neutral distribution

As BusyBox is one, and as thin: the smallest UNIX a browser runs and the command line #80 lists, ordinary POSIX
with no window, served from any web host as it is. It knows no service and nothing of root3's, so it can be cut
out with what is under it (`../muk`, `../sods`, `../lib`, each a folder of its own beside this one). `runtime/` is
its user-mode kernel (TypeScript, for now, and far from thin: docs/STRUCTURE.md): processes, a POSIX tree, file
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

The code it runs is sods' (`../sods`); what it reads at rest is read by muk (`../muk`) and put in its tree here
(`runtime/mount.ts`; a repo kept in step with the outside, `runtime/mirror.ts`). A Prompt's Worker
(`root3/app/prompt/kernel.worker.ts`, root3's for now) mounts the root and the repo and gives it the translations kept.

```
node runtime/run.ts PROGRAM [args...]            # host ELF as /bin/PROGRAM
node runtime/run.ts --root DIR /bin/sh -c '...'  # a host tree as /
sh tests/programs/run.sh                          # native vs translated, and the unit tests
node tests/floors/floors.ts                       # each floor beside Linux
sh tests/tree/tree.sh [DIR]                       # the tree (src/tree.h) beside Linux, every name of a directory
```
