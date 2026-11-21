# Why

Why is a workspace for editing repositories, running commands, and keeping
work in sync across devices. The web and desktop applications share a frontend.
The command-line client and both applications use the same Rust core. The
Remote handles accounts, synchronization, and shared work.

Use the [hosted application](https://os.length3.com) or get the Linux desktop
bundle from [GitHub releases](https://github.com/elysia090/os-length3/releases).
The desktop release includes the `why` command. On x86-64 Linux, install the
`.deb` or run the AppImage. The `*-web.zip` archive contains the web
application. The root archive and `*-webroot.tar` are the native and browser
forms of the pinned guest filesystem. Check release files against
`SHA256SUMS` before use.

To install the command from source, run this from the repository root:

```sh
cargo install --locked --path why/cli
```

Read the [operations guide](docs/operations.md) for command examples, SSH,
configuration, and deployment. The [behavior guide](docs/PLACES.md),
[application architecture](docs/OS.md), and [visual design](docs/DESIGN.md)
cover the product in more detail.

## Source layout

| Path | Responsibility |
| --- | --- |
| [`app/`](app/) | The TypeScript interface shared by browsers and the desktop. |
| [`lib.rs`](lib.rs), [`api/`](api/) | Rust core entry point and host adapters, including the browser's WebAssembly and worker interface. |
| [`cli/`](cli/), [`desktop/`](desktop/) | The command-line program and the Tauri desktop host. |
| [`repo/`](repo/), [`home/`](home/), [`device/`](device/) | Repositories and history, personal state, and device storage and capabilities. |
| [`prompt/`](prompt/), [`ssh/`](ssh/) | Guest environment selection and local SSH policy. |
| [`shipto/`](shipto/) | Synchronization, service policy, and the [Remote](shipto/remote/README.md). |
| [`build/`](build/), [`test/`](test/) | Product assembly and the unit, browser, CLI, and production test harnesses. |

Why chooses which Ricebox distribution release to use, and which storage and
capabilities to give to a guest. Ricebox supplies the root and execution
services; it can also be used [without Why](../ricebox/README.md).

## Development

Use Node 22.18 or later and a Rust toolchain with the `wasm32-wasip1` target.
Run these commands at the repository root:

```sh
rustup target add wasm32-wasip1
npm ci
npm run check
npm run dev
```

Vite builds the browser's Rust core when needed. `npm run build` produces the
web application in `dist/`. Prepare the browser Prompt's root before building
when it is needed: `node why/build/fetch-webroot.ts` installs the pinned release
artifact, or `npm run webroot` builds it with this checkout's Sods translator.
Building the web root also requires the Rust `wasm32-unknown-unknown` target
and a C compiler for Muk.

For Linux desktop development, install the WebKitGTK 4.1 and GTK 3 development
packages, librsvg, and Ayatana AppIndicator. An x86-64 Linux release bundle
also needs the Rust `x86_64-unknown-linux-musl` target, `musl-gcc`, and
`libgles2`; its entry point is `sh why/build/desktop.sh`.

| Check | Command |
| --- | --- |
| TypeScript and unit tests | `npm run check`; `npm test -- <file>` runs selected tests. |
| Browser workflows | `npx playwright install chromium`, then `npm run selftest` |
| CLI and local Remote | `npm run selftest:cli` builds the client, or uses the binary specified by `WHY`. |
| Remote with workerd and PostgreSQL | [Production-like selftests](test/prod/README.md) |
