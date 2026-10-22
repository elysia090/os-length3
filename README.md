# os-length3

**Length³ OS**: a work OS that is the same in a window, in a browser and on
the command line, over one Linux root, **OS Length3 Linux**. The root
itself comes from the post-link compiler in this repository, which reduces
each linked x86-64 ELF of a fixed Linux distribution to an equivalent,
smaller, ordinary executable.

```
             the desktop app (Tauri)      the web app        l3 (terminal, SSH)
                         \                     |                    /
                          one Rust core: repos, history, the Remote's sync, Home
                         /                     |                    \
   the Prompt:   the root on the host's    the root through xlat     the root on the host's
                 kernel (namespaces)       (x86-64 → wasm) in a      kernel (namespaces)
                                           Worker
                                               |
                       OS Length3 Linux: BusyBox, gcc, make, git, l3 … (one pinned root)
                                               |
                 compiler/ + distribution/: the post-link compiled, booted base root
```

## Get it

Every release is a [GitHub release](https://github.com/elysia090/os-length3/releases)
named `os-length3-linux-vX.Y.Z`; the current one is in [`os/RELEASE`](os/RELEASE),
and [`releases/README.md`](releases/README.md) lists them all. A release carries:

| File | What it is |
| --- | --- |
| `…-desktop-amd64.deb`, `…-desktop-x86_64.AppImage` | the desktop app for x86-64 Linux: `sudo apt install ./….deb`, or `chmod +x` the AppImage and run it |
| `…-web.zip` | the web app, ready for any static server (`npx serve` in the unzipped folder) |
| `…-x86_64-<sha256>.tar.zst` | the root (with `/usr/bin/l3`), which the app installs and trusts by that digest |
| `…-l3-web.tar` | the same root as a browser reads it (packs by package, BusyBox and l3 translated ahead of time) |
| `SHA256SUMS` | the digests of everything above |

[os.length3.com](https://os.length3.com) is the web app and its Remote,
where a signed-in person's repos, TODO and settings are kept between
devices. Building from source, `l3` is `cargo install --path os/cli`.

## Layout

| Directory | What is there | Start at |
| --- | --- | --- |
| [`os/`](os/) | **Length³ OS**: the app (TypeScript, no framework; Tauri for the window), `l3` (`cli/`), the core both use (`core/`, also built for `wasm32-wasip1` for the browser), and the Remote (`service/`: Hono on a Cloudflare Worker, Postgres on Neon) | [`os/README.md`](os/README.md), the design language in [`os/DESIGN.md`](os/DESIGN.md) |
| [`xlat/`](xlat/) | static x86-64 Linux programs as WebAssembly: the browser's Prompt runs the root through it | [`xlat/README.md`](xlat/README.md) |
| [`compiler/`](compiler/) | the post-link compiler: a linked x86-64 ELF (the kernel image included) to an equivalent, ordinary, optimized ELF, with its verifier and release tooling | [`compiler/README.md`](compiler/README.md) |
| [`distribution/`](distribution/) | `development-standard-v1`, the fixed distribution the base root is built, post-link compiled and booted as | [`distribution/README.md`](distribution/README.md) |
| [`releases/`](releases/) | every release, and the native base's notes, receipts and evidence | [`releases/README.md`](releases/README.md) |
| [`research/`](research/) | QM, the quotient-and-minimum idea at the scale of one C function ([`SPEC.md`](research/qm/SPEC.md)), and its categorized corpus | [`research/qm/SPEC.md`](research/qm/SPEC.md) |

`compiler/` is self-contained: it imports nothing from `research/`.

## Develop

Length³ OS (Node 22 and Rust with the `wasm32-wasip1` target):

```sh
cd os
npm ci
npm run check            # types, then every unit test (npm test)
npm run selftest         # the web app end to end in Chromium
npm run selftest:l3      # l3 end to end against a Remote of its own
npx tauri dev            # the desktop app against the dev server
```

The post-link compiler and the distribution are ordinary C and shell:

```sh
cd compiler && make -j4 && make check
cd distribution && ./build.sh   # on the fixed build host it describes
```

CI (`.github/workflows/desktop.yml`) runs on each pull request; what each
job does is in [`os/README.md`](os/README.md) (Develop, CI). A release is
made from main by changing [`os/RELEASE`](os/RELEASE)
(`.github/workflows/release.yml`), or by hand with `os/scripts/release.sh`
(see [`releases/README.md`](releases/README.md)).

## The compiler, in one line

> Take an ordinary linked x86-64 program and obtain another ordinary x86-64
> program — the same complete machine behaviour, less machine computation,
> with the equivalence verified rather than assumed.

Every linked `ET_EXEC`/`ET_DYN` of the distribution's closure is post-link
compiled before its package is signed, each optimized ELF is checked against
its linked input, and the packages are assembled into one root that boots.
What is and is not yet established (a complete semantic checker, the
canonical artifact size, speed) is in
[`compiler/postlink-compiler/`](compiler/postlink-compiler/) and
[`releases/native/RELEASE-0.1.0.md`](releases/native/RELEASE-0.1.0.md).

Security reports: [`SECURITY.md`](SECURITY.md).
