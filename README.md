# Why and Ricebox

**Why** is the application: a web and desktop workspace, a command-line client,
and a Remote for synchronization. **Ricebox** is the reusable Linux foundation:
a pinned distribution and the tools that build, translate and run it. You can
use Ricebox or its components without a Why account, server or application.

| If you want to… | Start here |
| --- | --- |
| Use, build or deploy Why | [Why](why/) and [product documentation](docs/README.md) |
| Build a root filesystem or embed its execution | [Ricebox](ricebox/) and [distribution installation](ricebox/distribution/docs/installation.md) |
| Translate or run a Linux program without the Ricebox distribution | [Sods](ricebox/sods/) |
| Run an OCI bundle on Linux | [Muk](ricebox/muk/) |
| Understand ownership and allowed dependencies | [Repository structure](docs/STRUCTURE.md) |

## Run Why

The hosted web application and Remote are at [os.length3.com](https://os.length3.com).
[GitHub releases](https://github.com/elysia090/os-length3/releases) include:

| Asset | Use |
| --- | --- |
| `…-desktop-amd64.deb` or `…-desktop-x86_64.AppImage` | Install or run the desktop app on x86-64 Linux. The packages include the `why` command. |
| `…-web.zip` | Unpack and serve the web application on a static host. |
| `…-x86_64-<sha256>.tar.zst` | The native root filesystem pinned by the application. |
| `…-webroot.tar` | The same root as static layers, with selected programs translated ahead of time. |
| `SHA256SUMS` | Check the release assets before use. |

To build just the CLI from source, run `cargo install --locked --path why/cli`
at the repository root. The source release version is in the
[version file](ricebox/distribution/RELEASE); the product trusts only its
[release pins](why/prompt/roots/pins.rs).

## Develop

From the repository root, use Node 22.18 or later for the application workspace,
and Rust with the `wasm32-wasip1` target:

```sh
rustup target add wasm32-wasip1
npm ci
npm run check
npm run dev
```

For browser tests, run `npx playwright install chromium` and `npm run selftest`.
Use `npm run selftest:cli` for CLI tests against a local Remote. Desktop build
requirements are in the [product documentation](docs/README.md).
Sods' local npm package uses Node 24 or later; see its
[build and target guide](ricebox/sods/README.md).

The workspace manifests and locks live at the root. Product code is in
[`why/`](why/), reusable components in [`ricebox/`](ricebox/), and the
[shared documentation](docs/) describes how they fit together. Package recipes,
pins and the neutral root build live together in
[`ricebox/distribution/`](ricebox/distribution/).

See [security reporting](docs/SECURITY.md) for reporting a vulnerability.
