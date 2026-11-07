# os-length3

**Length³ OS**: a work OS that is the same in a window, in a browser and on
the command line, over one Linux root, **OS Length3 Linux**: thirty packages,
each made from the source this repository pins by its recipe
([`os/root/`](os/root/)), static, hardened and checked by use, and `l3`.

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
                 os/root/: each package from its pinned source by its recipe, on one pinned Alpine
```

## Get it

Every release is a [GitHub release](https://github.com/elysia090/os-length3/releases)
named `os-length3-linux-vX.Y.Z`; the current one is in [`os/RELEASE`](os/RELEASE).
A release carries:

| File | What it is |
| --- | --- |
| `…-desktop-amd64.deb`, `…-desktop-x86_64.AppImage` | the desktop app for x86-64 Linux, with `l3` beside it: `sudo apt install ./….deb` (then `l3`, or `l3 app` for the window), or `chmod +x` the AppImage and run it |
| `…-web.zip` | the web app, ready for any static server (`npx serve` in the unzipped folder) |
| `…-x86_64-<sha256>.tar.zst` | the root (with `/usr/bin/l3`), which the app installs and trusts by that digest |
| `…-l3-web.tar` | the same root as a browser reads it (packs by package, BusyBox and l3 translated ahead of time) |
| `SHA256SUMS` | the digests of everything above |

[os.length3.com](https://os.length3.com) is the web app and its Remote,
where a signed-in person's repos, TODO and settings are kept between
devices. Building from source, `l3` is `cargo install --path os/l3`.

## Layout

| Directory | What is there | Start at |
| --- | --- | --- |
| [`os/`](os/) | **Length³ OS**: the app (TypeScript, no framework; Tauri for the window), `l3` (`cli/`), the core both use (`core/`, also built for `wasm32-wasip1` for the browser), and the Remote (`service/`: Hono on a Cloudflare Worker, Postgres on Neon) | [`os/README.md`](os/README.md), the design language in [`os/DESIGN.md`](os/DESIGN.md) |
| [`xlat/`](xlat/) | static x86-64 Linux programs as WebAssembly: the browser's Prompt runs the root through it | [`xlat/README.md`](xlat/README.md) |

The root is [`os/root/`](os/root/): what it is made from (`sources.env`, the pins), one recipe per package
(`packages/`), its own settings (`etc/`), and what makes it (`build.sh`, each package on Alpine 3.24 at one digest;
`assemble.sh`, the root and its package database; `next.py`, every source's newest release).

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

The root (Docker, for its build machine; the packages are kept in `os/target/root-packages` and each is made again
only when what it is made of changed):

```sh
docker run --rm -v "$PWD:/w" alpine@sha256:c26612752c78b18faacd63c7d50f4592c2e7b0f25e0e20e82bd74e465c57ab0d \
  sh /w/os/root/build.sh /w/os/target/root-packages
cd os && sh root/assemble.sh target/root-packages target/root-made
```

CI (`.github/workflows/desktop.yml`) runs on each pull request; what each
job does is in [`os/README.md`](os/README.md) (Develop, CI). A release is
made from main by changing [`os/RELEASE`](os/RELEASE)
(`.github/workflows/release.yml`), or by hand with `os/scripts/release.sh`.

Security reports: [`SECURITY.md`](SECURITY.md).
