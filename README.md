# Why and Ricebox

**Why** is the application: a web and desktop workspace, a command-line client,
and a Remote for synchronization. **Ricebox** is the reusable Linux foundation:
a pinned distribution and the tools that build, translate and run it. You can
use Ricebox or its components without a Why account, server or application.

| If you want to… | Start here |
| --- | --- |
| Use, build or deploy Why | [Why](why/README.md) |
| Build a root filesystem or embed its execution | [Ricebox](ricebox/) and [distribution installation](ricebox/distribution/docs/installation.md) |
| Translate or run a Linux program without the Ricebox distribution | [Sods](ricebox/sods/) |
| Run an OCI bundle on Linux | [Muk](ricebox/muk/) |
| Understand ownership and allowed dependencies | [Repository structure](docs/STRUCTURE.md) |

## Workspace

The workspace manifests and locks live at the root. Product code is in
[`why/`](why/README.md), reusable components in [`ricebox/`](ricebox/README.md), and the
[shared documentation](docs/README.md) describes how they fit together. Package recipes,
pins and the neutral root build live together in
[`ricebox/distribution/`](ricebox/distribution/).

See [security reporting](docs/SECURITY.md) for reporting a vulnerability.
