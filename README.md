# os-length3

**Length³ OS**: a work OS that is the same in a window, in a browser and on
the command line, over one Linux root, **OS Length3 Linux**: thirty packages,
each made from the source this repository pins by its recipe
([`root/`](root/)), static, hardened and checked by use, and `l3`.

```
             the desktop app (Tauri)      the web app        l3 (terminal, SSH)
                         \                     |                    /
                          one Rust core: repos, history, the Remote's sync, Home
                         /                     |                    \
   the Prompt:   the root on the host's    the root on ricebox's     the root on the host's
                 kernel (namespaces)       kernel, made wasm by      kernel (namespaces)
                                           sods, in a Worker
                                               |
                       OS Length3 Linux: BusyBox, gcc, make, git, l3 … (one pinned root)
                                               |
                 root/: each package from its pinned source by its recipe, on one pinned Alpine
```

## Get it

Every release is a [GitHub release](https://github.com/elysia090/os-length3/releases)
named `os-length3-linux-vX.Y.Z`; the current one is in [`RELEASE`](RELEASE).
A release carries:

| File | What it is |
| --- | --- |
| `…-desktop-amd64.deb`, `…-desktop-x86_64.AppImage` | the desktop app for x86-64 Linux, with `l3` beside it: `sudo apt install ./….deb` (then `l3`, or `l3 app` for the window), or `chmod +x` the AppImage and run it |
| `…-web.zip` | the web app, ready for any static server (`npx serve` in the unzipped folder) |
| `…-x86_64-<sha256>.tar.zst` | the root (with `/usr/bin/l3`), which the app installs and trusts by that digest |
| `…-webroot.tar` | the same root as a browser reads it (packs by package, BusyBox and l3 translated ahead of time) |
| `SHA256SUMS` | the digests of everything above |

[os.length3.com](https://os.length3.com) is the web app and its Remote,
where a signed-in person's repos, TODO and settings are kept between
devices. Building from source, `l3` is `cargo install --path src/cli`.

## Layout

| Directory | What is there | Start at |
| --- | --- | --- |
| [`src/`](src/) | **Length³ OS**: the app ([`app/`](src/app/), TypeScript, no framework; [`desktop/`](src/desktop/), Tauri for the window), [`cli/`](src/cli/), the `l3` command, the core both use ([`core/`](src/core/), also built for `wasm32-wasip1` for the browser), and the Remote ([`remote/`](src/remote/): Hono on a Cloudflare Worker, Postgres on Neon) | [`docs/README.md`](docs/README.md), the design language in [`docs/DESIGN.md`](docs/DESIGN.md) |
| [`module/`](module/) | the units, each a folder of its own: [`sods/`](module/sods/) instructions (static x86-64 Linux programs made WebAssembly ahead of the run), [`ricebox/`](module/ricebox/) the box (the smallest UNIX a browser runs: the kernel the root runs on in a browser's Prompt), [`muk/`](module/muk/) what is at rest (packs and translations by digest, the repo in step); and [`you/`](module/you/), [`otter/`](module/otter/), [`lib/`](module/lib/), units of C with no C library (the tools a person reaches for, z and rg; help and what each thing is; what they stand on) | each unit's `README.md`, or its files' heads |
| [`root/`](root/) | the root the Prompts run: its pins, a recipe per package and what makes it (below) | `build.sh` |
| [`scripts/`](scripts/), [`tests/`](tests/) | what builds, releases and checks (`npm test` runs `scripts/tests.ts`), and the selftests: the app driven in a browser as a person drives it (`npm run selftest`) | each file's head |
| [`docs/`](docs/) | what the OS is and how it ships ([`README.md`](docs/README.md)), its design language ([`DESIGN.md`](docs/DESIGN.md)), what it promises about security ([`SECURITY.md`](docs/SECURITY.md)) | |

`package.json`, `Cargo.toml` (one workspace: the core, the app's window and l3), `vite.config.ts`, `index.html` and
`public/`, `wrangler.toml` (the Remote's Worker) and `RELEASE` (this tree's version) are at the top, as each tool
looks for them.

The root is [`root/`](root/): what it is made from (`sources.env`, the pins), one recipe per package
(`packages/`), its own settings (`etc/`), and what makes it (`build.sh`, each package on Alpine 3.24 at one digest;
`assemble.sh`, the root and its package database; `next.py`, every source's newest release).

## Units

What the directories hold is being sorted into units, each one responsibility, peeled from the outside in by how
easily a person changes it; what is left inside is ricebox's, the smallest UNIX a browser runs. Every byte is
running (ricebox), at rest (muk) or on its way (funk). The faces (the app's pages and window, l3's words) hold no
judgement of their own. [`scripts/units.ts`](scripts/units.ts) is the table: each unit's files and the units it
may take from, checked by `npm test` (an import a unit still makes and may not is listed there as owed, with the step
below that ends it).

| Unit | Its responsibility | Takes from |
| --- | --- | --- |
| you | the tools a person reaches for: z, rg, fd, fzf | lib |
| m8 | where and how many boxes run: a state wanted, one loop that makes it so (made when boxes run on more than one machine) | ricebox, muk, shipto |
| shipto | deliveries: what goes where and who takes it (commits, reviews, merges, messages, releases), the Remote that receives them, its own deploy | muk, funk |
| funk | what is on its way: links out of a box and between boxes (HTTP, TCP, DNS, WebSocket, SSH) | ricebox |
| muk | what is at rest: layers by digest, a layer written over them, names for digests; each byte fetched when first touched | ricebox |
| otter | to see and to decide: every floor counted at its hook, small bounded policies put at the hooks, each said | ricebox, muk, sods |
| sods | instructions: x86-64 made wasm ahead of the run, kept and shared by digest, never crossing to JS | — |
| ricebox | the box: the smallest UNIX inside (processes, memory and its page cache, files, descriptors, the terminal, signals) and the box started, frozen and copied | sods |

The steps, each moving files without changing what they do before changing anything, the tests green at each:
0 the table and its check; 1 #80's requirements as tests of the web Prompt; 2 sods out of xlat; 3 ricebox made of the
rest of xlat's runtime, the box and its UNIX apart; 4 otter's hooks and `otter -- CMD`; 5 the floors lowered, each
measured beside Linux on the same machine; 6 muk; 7 shipto; 8 funk with the HTTP gateway; 9 m8.

## Develop

Length³ OS (Node 22 and Rust with the `wasm32-wasip1` target):

```sh
npm ci
npm run check            # types, then every unit test (npm test)
npm run selftest         # the web app end to end in Chromium
npm run selftest:cli     # l3 end to end against a Remote of its own
npx tauri dev            # the desktop app against the dev server
```

The root (Docker, for its build machine; the packages are kept in `target/root-packages` and each is made again
only when what it is made of changed):

```sh
docker run --rm -v "$PWD:/w" alpine@sha256:c26612752c78b18faacd63c7d50f4592c2e7b0f25e0e20e82bd74e465c57ab0d \
  sh /w/root/build.sh /w/target/root-packages
sh root/assemble.sh target/root-packages target/root-made
```

CI (`.github/workflows/ci.yml`) runs on each pull request; what each
job does is in [`docs/README.md`](docs/README.md) (Develop, CI). A release is
made from main by changing [`RELEASE`](RELEASE)
(`.github/workflows/release.yml`), or by hand with `scripts/release.sh`.

Security reports: [`SECURITY.md`](docs/SECURITY.md).
