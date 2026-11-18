# Repository structure

[Why](../why/) is a product. [Ricebox](../ricebox/) is the reusable Linux
foundation it uses. A consumer can assemble a Ricebox root, build Muk, or
translate a program with Sods independently of Why.

## Ownership

| Path | Owner and entry point |
| --- | --- |
| `why/` | The Why Rust core, web and desktop applications, CLI, and hosted Remote. Product decisions include which releases are trusted, what storage and input/output to lend a guest, and how to authorize its operations. |
| `why/ssh/` | Why’s local SSH policy and host adapter. Guest networking is a separate component in `ricebox/cowboy/`. |
| `why/shipto/` | Why's Remote clients and synchronization adapters. The hosted service in `why/shipto/remote/` shares SSH scope values and release pins with the product. The clients and service do not import each other’s implementations. |
| `ricebox/distribution/` | The neutral distribution: package recipes, native archive, web layers, and their execution and delivery adapters. See the [distribution guide](../ricebox/distribution/README.md). |
| `ricebox/sods/` | The translator and its ABI, the guest Linux services, and porting interfaces. See the [public entry points and target table](../ricebox/sods/README.md). |
| `ricebox/muk/` | The native Linux OCI runner. Its external interface is an OCI bundle and a process, not a library or a root distribution. |
| `ricebox/you/` | Directory history and tree search commands. |
| `ricebox/otter/` | Command help and pinned package acquisition. Catalogs and downloads are independent of distribution assembly. |
| `ricebox/cowboy/`, `ricebox/everyday/` | Guest networking and independent theme-value processing. Why's device and service adapters stay in Why. |
| `ricebox/toolchain/` | Shared build support for the freestanding C components. It is not a runtime package. |
| `docs/` | Shared contracts and the reasoning behind them. Put component setup and API details beside their implementation. |

The Cargo and npm locks, TypeScript settings, CI and cross-repository checks
live at the root. A shared build workspace is not a runtime dependency. Build
outputs do not belong in the source tree or in a runtime dependency graph.
[Why's build tools](../why/build/) compose the product's guest root, prepare
or fetch its web assets, and build the browser's Rust core. They consume
Ricebox's build tools and formats; Why's runtime does not import them.

## Dependency direction

```text
Why ──► Ricebox distribution, guest networking, theme values
        Ricebox distribution ──► Sods or Muk, selected commands
        Sods / Muk / You / Otter ──► shared freestanding C tools (where used)
        Cowboy ──► Sods host-facing types
```

- Muk and Sods share a Linux ABI contract; neither imports the other's
  implementation. A host can run Muk on Linux or run its program against
  the Linux services provided by Sods.
- The distribution's [terminal helper](../ricebox/distribution/terminal/)
  receives a terminal descriptor and attaches to it. Muk creates the terminal
  and gives the other end to its caller. The helper starts no process.
- The Why browser worker owns local IndexedDB persistence. Its transaction
  adapter takes an already opened database. It does not choose a volume or
  authorize a guest, and it is not a general Ricebox persistence feature.
- Why can add its CLI and defaults to an archive it creates without
  introducing a dependency on product code in Ricebox. The native runner and
  the web loader are different host adapters for the same guest content.

## Distribution boundaries

- [`format/`](../ricebox/distribution/format/) describes packs, manifest
  identities, inventory and the mounting contract. It contains no host I/O.
- [`build/`](../ricebox/distribution/build/) turns selected, already built or
  pinned packages into the root and layers. It is not a dependency of the
  execution runtime.
- [`runtime/`](../ricebox/distribution/runtime/) handles loading, caching,
  startup, and the Worker on the web execution path.
- [`src/`](../ricebox/distribution/src/) holds the native Rust archive and
  container integration.
- [`deployment/`](../ricebox/distribution/deployment/) reads and serves
  prepared artifacts; [`integrations/`](../ricebox/distribution/integrations/)
  connects the build or a prepared distribution to Vite.
- [`verification/`](../ricebox/distribution/verification/) tests the finished
  native and web forms against each other. Build and runtime code do not
  import verification.

The source paths are not npm entry names. Inspect the generated package
manifests for `ricebox`, `ricebox/prepare`, `ricebox/vite` and the four
`sods/*` entries. They are private, installable build outputs, not claims of
registry publication or support for every JavaScript host.

## Checks

[`scripts/units.ts`](../scripts/units.ts) checks TypeScript ownership, Worker module URLs and
public entry points without inferring them from folder names.
[`scripts/runtime-boundaries.ts`](../scripts/runtime-boundaries.ts) also
checks host facilities and dependencies encoded as Worker URLs. Cargo and
the C build suites verify their own dependencies. The package suites load
the generated JavaScript from a different working directory; release
verification checks the names, modes, links and content of both root forms.
`npm test` runs workspace and Ricebox checks in independent processes. Why
suites use the [product unit harness](../why/test/unit/) for application
modules and hosted-service database fixtures.
