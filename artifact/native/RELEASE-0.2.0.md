# OS Length3 Linux 0.2.0

The executable bundle is **65,134,931 bytes**, SHA-256
`1008fe2d6d5b7d02de4c6c0756517113ba6cf20706ee92ca480044c76e7e7540`
(`os-length3-linux-0.2.0-x86_64-1008fe2d…7540.tar.zst`).

The 0.1.0 root, repackaged so the OS and the app are one thing in the same
words. Nothing of 0.1.0's root is changed or removed; four files are added:

- `/usr/bin/l3`: the l3 command, static (musl), built from this repository.
  It speaks the app's rail — Home, Forge and its Prompt, File, Git, Runtime,
  Remote — and in a Prompt sees the open repo at `/root/<repo>`, leaving
  Home, the Remote and the device to the app.
- `/etc/os-release`: `ID=length3`, `VERSION_ID=0.2.0`.
- `/etc/profile` and `/etc/length3/shrc`: the Prompt's shell. Its prompt is
  the open repo and where you are in it; `l3 help` names the rest.

The bundle is made by `src/desktop/scripts/root-release.sh` from the pinned
0.1.0 bundle (`56229f24…d7b4`) and the l3 of the commit its manifest names
(`l3.source` = `060c528f`, l3 SHA-256 `16f391f0…fad6`); the manifest is
kept beside this page as `os-length3-linux-0.2.0.manifest`. The tar is sorted with time and owner 0 and compressed with
fixed zstd settings, so the same inputs give the same bytes; two builds were
compared byte for byte (from a clean l3 build each time). Its `manifest` names the base, l3 and the script, then
carries 0.1.0's own manifest under `base.`.

## Download and authenticate

l3 and the app pin this release by digest (`core/src/root.rs`) and install
nothing else. `l3 root fetch` (or Runtime's 入れる) takes it from the Remote,
or from this release channel when the Remote does not have it, continuing a
cut transfer and checking the digest before reading a byte. By hand:

```sh
sha256sum -c SHA256SUMS
l3 root install os-length3-linux-0.2.0-x86_64-<sha256>.tar.zst
l3 prompt REPO
```

## Checked

Installed with `l3 root install` (5,876 files, 243.7 MB) and opened with
`l3 prompt`: `/etc/os-release` reads 0.2.0, `/usr/bin/l3` lists the open
repo and writes an issue into it (seen on the host), declines Home's TODO,
and the shell's prompt reads `notes $`, then `notes/src $`; `make` builds and
runs the C template.

A crash seen while checking was not the root's: the launcher handed the
Prompt SIGPIPE ignored (Rust ignores it, and that survives exec), so a
program writing to a closed pipe got EPIPE and GNU make then crashed. The
launcher (host-side l3) now starts the shell with every signal at its
default and none blocked; `make | head -n 0` and `yes | head` end normally
on 0.1.0's root and this one.

## What this release does not change

Everything 0.1.0 measured and left open still stands as written in
[Release 0.1.0](RELEASE-0.1.0.md): the root's programs, their post-link
compilation, the kernel and initramfs, the package key and its limits. This
release adds no new claim about them.
