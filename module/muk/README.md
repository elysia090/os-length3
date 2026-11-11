# muk — the OCI-compatible VMM

The thinnest part of ricebox: an image's layers at rest, named by their digest, each byte fetched when it is first
touched, and a bundle run from them (created, started, signalled, deleted, as the OCI runtime says). No KVM and no
Firecracker under it. It is to be C on `../lib` alone, with no C library, written as `../you` is: what it does
counted by hand first, then written until callgrind and the disassembly show that sequence.

Today it holds what reads a pack: a file's bytes by a Range of its pack, used only once they are what the pack's
table says (`runtime/pack.ts`, `runtime/table.ts`), and the copies a Prompt keeps between runs, sealed by their
digest (`runtime/keeper.ts`; what a translation's copy holds is sods' `kept.ts`). A Prompt on Linux is still run
by root3's core (`src/core/src/prompt`: namespaces, the root under an overlay, a seccomp filter, an init), which
becomes the bundle root3 writes once muk runs one.

What puts a pack's tree in a kernel's, and keeps a repo there in step with the outside, is the kernel's
(`../ricebox/runtime/mount.ts`, `mirror.ts`); their tests run with ricebox's.
