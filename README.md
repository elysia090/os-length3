# root3

**root3** is the OS: everything this repository holds. Its modules ([`module/`](module/)) are each a unit of its
own, built and shipped on its own; root3 is what is left once they are peeled off (the app, the `root3` command and
the one Rust core under both, the Remote) together with all of them, and the Linux root its Prompts run, **OS Length3
Linux** ([`root/`](root/)): thirty packages, each made from the source this repository pins by its recipe, static,
hardened and checked by use.

| Ships | What it is |
| --- | --- |
| root3 | the releases below: the root, the web root, the web app and the desktop app, with `root3` in each |
| [`module/sods`](module/sods/) | the x86-64 → WebAssembly translator (`xlat`, and as wasm with its runtime) |
| [`module/ricebox`](module/ricebox/) | the neutral distribution, as BusyBox is one: the smallest UNIX a browser runs, the kernel a browser's Prompt runs the root on |
| [`module/muk`](module/muk/) | the thinnest part of it: an OCI-compatible VMM (today the root's packs read when first touched and copies kept by digest) |
| [`module/you`](module/you/), [`module/otter`](module/otter/), [`module/lib`](module/lib/) | units of C with no C library: z, rg, fd and fzf; help and what each thing is; what they stand on |

```
             the desktop app (Tauri)      the web app        root3 (terminal, SSH)
                         \                     |                    /
                          one Rust core: repos, history, the Remote's sync, Home
                         /                     |                    \
   the Prompt:   the root on the host's    the root on ricebox's     the root on the host's
                 kernel (namespaces)       kernel, made wasm by      kernel (namespaces)
                                           sods, in a Worker
                                               |
                       OS Length3 Linux: BusyBox, gcc, make, git, root3 … (one pinned root)
                                               |
                 root/: each package from its pinned source by its recipe, on one pinned Alpine
```

## Get it

Every release is a [GitHub release](https://github.com/elysia090/os-length3/releases)
named `os-length3-linux-vX.Y.Z`; the current one is in [`root/RELEASE`](root/RELEASE).
A release carries:

| File | What it is |
| --- | --- |
| `…-desktop-amd64.deb`, `…-desktop-x86_64.AppImage` | the desktop app for x86-64 Linux, with `root3` beside it: `sudo apt install ./….deb` (then `root3`, or `root3 app` for the window), or `chmod +x` the AppImage and run it |
| `…-web.zip` | the web app, ready for any static server (`npx serve` in the unzipped folder) |
| `…-x86_64-<sha256>.tar.zst` | the root (with `/usr/bin/root3`), which the app installs and trusts by that digest |
| `…-webroot.tar` | the same root as a browser reads it (packs by package, BusyBox and root3 translated ahead of time) |
| `SHA256SUMS` | the digests of everything above |

[os.length3.com](https://os.length3.com) is the web app and its Remote,
where a signed-in person's repos, TODO and settings are kept between
devices. Building from source, `root3` is `cargo install --path src/cli`.

## Layout

| Directory | What is there | Start at |
| --- | --- | --- |
| [`src/`](src/) | **Length³ OS**: the app ([`app/`](src/app/), TypeScript, no framework; [`desktop/`](src/desktop/), Tauri for the window), [`cli/`](src/cli/), the `root3` command, the core both use ([`core/`](src/core/), also built for `wasm32-wasip1` for the browser), and the Remote ([`remote/`](src/remote/): Hono on a Cloudflare Worker, Postgres on Neon) | [`docs/README.md`](docs/README.md), the design language in [`docs/DESIGN.md`](docs/DESIGN.md) |
| [`module/`](module/) | the units, each a folder of its own: [`sods/`](module/sods/) instructions (static x86-64 Linux programs made WebAssembly ahead of the run), [`ricebox/`](module/ricebox/) the neutral distribution's own (the smallest UNIX a browser runs: the kernel the root runs on in a browser's Prompt), [`muk/`](module/muk/) its thinnest part, the OCI-compatible VMM (today a pack's bytes read by digest when first touched); and [`you/`](module/you/), [`otter/`](module/otter/), [`lib/`](module/lib/), units of C with no C library (the tools a person reaches for, z and rg; help and what each thing is; what they stand on) | each unit's `README.md`, or its files' heads |
| [`root/`](root/) | the root the Prompts run: its pins, a recipe per package and what makes it (below) | `make/build.sh` |
| [`scripts/`](scripts/), [`tests/`](tests/) | what builds, releases and checks (`npm test` runs `scripts/tests.ts`), and the selftests: the app driven in a browser as a person drives it (`npm run selftest`) | each file's head |
| [`docs/`](docs/) | what the OS is and how it ships ([`README.md`](docs/README.md)), what the repository is to be and the order it is taken apart in ([`STRUCTURE.md`](docs/STRUCTURE.md)), its design language ([`DESIGN.md`](docs/DESIGN.md)), what it promises about security ([`SECURITY.md`](docs/SECURITY.md)) | |

A folder holds files, or folders and at most its own README and manifests, never both. At the top are root3's own
manifests alone: `package.json`, `Cargo.toml` (one workspace: the core, the app's window and root3), `tsconfig.json`
and `wrangler.toml` (the Remote's Worker, where Workers Builds looks for it), with their lockfiles and the dotfiles
tools read there (`.node-version`, `.gitignore`, `.gitattributes`, `.cargo/`). The web app's page
and its build are in [`src/app/`](src/app/) (`index.html`, `vite.config.ts`); what it ships beside its build is
[`public/`](public/).

The root is [`root/`](root/): its version (`RELEASE`, the release it is made as next), what it is made from (`pins/`:
`sources.env`, and `advisories.toml`), a folder per package with its recipe and its patches (`packages/NAME/recipe.sh`),
its own files (`etc/`, `usr/`), and what makes it (`make/`: `build.sh`, each package on Alpine 3.24 at one digest;
`assemble.sh`, the root and its package database; `next.py`, every source's newest release).

## Units

The repository is split by what a person would be glad to find on a release: four things, each thin, beside one
another, none holding another, each standing on what is under it. Read from the top, the code is those four.

- **muk**, the thinnest: an OCI-compatible VMM. An image's layers at rest, named by their digest, and a bundle run
  from them (created, started, signalled, deleted, as the OCI runtime says). No KVM and no Firecracker under it: it
  is C on `lib` alone, with no C library, written as `you` is.
- **sods**: x86-64 made wasm ahead of the run, so a program built for Linux runs in a browser.
- **ricebox**, the neutral distribution, as BusyBox is one, and as thin: the smallest UNIX a browser runs and the
  command line [#80](https://github.com/elysia090/os-length3/issues/80) lists, ordinary POSIX with no window, over
  muk and sods; served from any web host as it is. It knows no service, so anyone can cut it out, with what is
  under it, and put it under a service of their own.
- **root3**, the product, as Alpine stands on BusyBox: ricebox, the root's packages, the app and the command, and
  the modules a product has. What a service wants (who one is, what one may use, the Remote and its sync, its
  gateway's rules, its deploy) is shipto's, and nowhere else.

The smaller modules are each a part of the one that ships it (you and otter, ricebox's command line's own programs;
shipto, funk and m8, root3's), or what several stand on (lib).

[`docs/STRUCTURE.md`](docs/STRUCTURE.md) is the whole of it: what each unit is and is not, what it is to be, how far
each is from its bound today, and the order they are taken apart in, the furthest first.
[`scripts/units.ts`](scripts/units.ts) is the table `npm test` checks: each unit's files and the units it may take
from; ricebox and the units under it take from nothing over them, and muk stands on lib alone.

| Unit | Its responsibility | Takes from |
| --- | --- | --- |
| lib | what the units of C stand on: system calls, words, output; no C library | — |
| muk | the OCI-compatible VMM: layers by digest, each byte fetched when first touched, and a bundle run from them | lib |
| sods | instructions: x86-64 made wasm ahead of the run, kept and shared by digest, never crossing to JS | — |
| ricebox | the neutral distribution: the smallest UNIX a browser runs (processes, memory and its page cache, files, descriptors, the terminal, signals) and the command line #80 lists | lib, muk, sods |
| you | the tools a person reaches for: z, rg, fd, fzf | lib |
| otter | to see and to decide: every floor counted at its hook, small bounded policies put at the hooks, each said | lib, ricebox, muk, sods |
| funk | what is on its way: links out of a box and between boxes (HTTP, TCP, DNS, WebSocket, SSH) | ricebox |
| shipto | what a service wants: who one is, what one may use, deliveries (commits, reviews, merges, messages, releases), the Remote that receives them, its own deploy | ricebox, muk, funk |
| m8 | where and how many boxes run: a state wanted, one loop that makes it so (made when boxes run on more than one machine) | ricebox, muk, shipto |

## Develop

Length³ OS (Node 22 and Rust with the `wasm32-wasip1` target):

```sh
npm ci
npm run check            # types, then every unit test (npm test)
npm run selftest         # the web app end to end in Chromium
npm run selftest:cli     # root3 end to end against a Remote of its own
npx tauri dev            # the desktop app against the dev server
```

The root (Docker, for its build machine; the packages are kept in `target/root-packages` and each is made again
only when what it is made of changed):

```sh
docker run --rm -v "$PWD:/w" alpine@sha256:c26612752c78b18faacd63c7d50f4592c2e7b0f25e0e20e82bd74e465c57ab0d \
  sh /w/root/make/build.sh /w/target/root-packages
sh root/make/assemble.sh target/root-packages target/root-made
```

CI (`.github/workflows/ci.yml`) runs on each pull request; what each
job does is in [`docs/README.md`](docs/README.md) (Develop, CI). A release is
made from main by changing [`root/RELEASE`](root/RELEASE)
(`.github/workflows/release.yml`), or by hand with `scripts/release.sh`.

Security reports: [`SECURITY.md`](docs/SECURITY.md).
