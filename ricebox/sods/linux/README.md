# Sods managed Linux runtime

This crate implements Linux execution state for selected WebAssembly
callers. It owns prepared namespaces, descriptors, execution and memory
identities, and pending syscall effects. The [x86-64 translator](../)
produces guest code; the [file store](../file-store/) owns regular-file
payloads. Node and browser integrations provide physical resources and
choose which execution profile, if any, to use.

## Run a static program in the managed Node profile

Use Linux and Node 22 or 24. The managed CLI requires non-TTY stdin,
stdout, and stderr. Build the ordinary Linux artifact and the translator
from the repository root:

```sh
rustup target add wasm32-unknown-unknown
cargo build --locked --release --target wasm32-unknown-unknown \
  --manifest-path ricebox/sods/linux/Cargo.toml
cargo build --locked --release --target wasm32-unknown-unknown --lib \
  --manifest-path ricebox/sods/Cargo.toml
```

Run a static x86-64 Linux ELF using both artifacts:

```sh
SODS_LINUX_WASM=ricebox/sods/linux/target/wasm32-unknown-unknown/release/sods_linux.wasm \
SODS_CURRENT_TRANSLATOR_WASM=ricebox/sods/target/wasm32-unknown-unknown/release/sods.wasm \
node ricebox/sods/runtime/run.ts --managed ./program.elf \
  </dev/null >stdout.log 2>stderr.log
```

The CLI captures the program once, installs it at `/bin/<basename>`, and
starts it in `/root` in a sealed guest filesystem. It does not mount the
host filesystem or accept the ordinary runner's root, TTY, or translation
options. It preserves the result of each physical write rather than
retrying until the whole request succeeds. Without `--managed`, the CLI
uses the existing TypeScript runtime.

## Integration entry points

- [`managedRoot`](../runtime/linux.ts) accepts a trusted matching
  Linux WebAssembly module and explicit memory and action capacities.
  It prepares a read-only root, transports sources, and runs a fixed-memory
  Node Worker. The [prepared-root contract](ROOT-AOT.md) describes the
  available operations, image selection, source identities, and retirement.
- [`capturedResultHost`](../runtime/linux.ts) explicitly selects an
  independently pinned bounded result artifact. It is available on Linux
  x86-64 with Node 22 or 24; the application takes labelled owned output
  separately. It does not provide synchronous physical-output semantics.
- The [owned stdout profile](OUTPUT-PROFILES.md#synchronous-owned-stdout)
  is a private Node integration, not a public package entry point or
  default CLI flag. A single output action may use a separately owned
  non-append file. No borrowed descriptor is promoted to that role.

The private Linux Wasm ABI is **7**, independent of the file-store
artifact's ABI. Entry points do not expose the Core instance, raw engine
memory, diagnostic inode operations, or generic memory mutation. An
unsupported artifact is rejected; shape checking alone does not establish
provenance. See [Linux output profiles](OUTPUT-PROFILES.md) for limits,
ownership, and distribution selection.

## Resource ownership

| Owner | Responsibility |
| --- | --- |
| Execution and memory domain | Fixed physical memory bindings, admitted images and invocations, and the bounded action table. |
| Files and prepared-root catalog | Namespace, inode and hardlink identity, file contents, source locations, and prepared-image associations. |
| Filesystem context and mount arena | Held root and cwd, mount positions and their lifetimes, and context sharing. |
| Descriptor table and open descriptions | Per-slot flags, retained open descriptions, file cursors, and borrowed host capabilities. |
| Syscall continuation | The exact request, argument capture, action prerequisites, and completion. |
| Host | Actual Worker and engine objects, synchronous copies or native transfers, source callbacks, and observations of ended access and exit. |

An action starts once and cannot be reissued when its outcome is unknown.
A stopped receipt must establish both ended access and no further effects.
A confirmed prefix alone does not authorize release. Retirement checks
the original owner and its outstanding obligations; a replacement numeric
descriptor, memory sequence, or source attempt cannot settle them.

The separate fixed-memory and diagnostic paths exercise this protocol,
but they do not grant a general public memory API. The private host assumes
a trusted JavaScript realm. It does not sandbox arbitrary host callbacks
or provide process-wide 64-bit address-space, guard-page, or guest-mapping
fault semantics.

### Files, paths, and reads

An open description owns its cursor and, where mounted, one view hold.
Descriptor aliases share the description. Independent opens of an inode
have independent cursors. A pending operation retains the original
description even if every referring descriptor is closed. Files is sealed
for the selected profile: resident backing is not truncated, replaced,
or evicted while a canonical range can refer to it.

Rust resolves paths and checks credentials and view flags from the
captured root, cwd, directory descriptor, and pathname. The host copies
a bounded NUL-terminated pathname; it does not normalize guest strings or
choose an inode. The private regular-file subset supports read-only
`open` and `openat`, regular reads, and `close`. See
[Read-only open](OPEN-CALLER.md) for access flags, fd limits, pathname
fault ordering, and cancellation.

A resident read delivers its checked prefix in one synchronous copy to
guest memory. A cold read has an independent source attempt before
destination access. A stopped matching receipt commits only the confirmed
prefix to the original cursor. Unknown results retain the source,
destination, and cursor reservation without permission to replay.
[Output ownership](OUTPUT-OWNERSHIP.md) describes canonical range pins,
which can outlive the producer's descriptor without holding another
OFD reference.

The internal filesystem and mount arenas support distinct positions and
view lifetimes, not public guest mount, pivot, propagation, or unmount
semantics. Namespace, descriptor table, filesystem context, and memory
sharing are independent.

### Startup, Worker calls, and streams

Rust checks the selected executable and retains its identity across
source delivery, translation, and image initialization. Prepared images
can start without materializing the underlying ELF. Rust builds the
stack and determines guest argument addresses, auxv, and RSP. The host
copies the bounded stack and validated image data before handing memory
to the Worker. The stack wire admits at most 2 MiB of data, 128 KiB per
NUL-terminated string, and 65,536 argument/environment pointers. These are
profile limits, not general Linux resource-limit compatibility.

Borrowed stream targets are not guest-supplied native file descriptors.
For supported read or write requests, Rust checks the direction and
requested range, then permits one synchronous physical call. A known
zero-effect error and an unknown result are different. Node may perform
multiple kernel calls internally, and an observed Worker exit does not
by itself settle host access. See [Sendfile](SENDFILE-OWNER.md) for the
separate source/output protocol.

The selected Worker also supports a
[low-address FS register handoff](TLS-CALLER.md) and
[single-task registration and exit](TASK-CALLER.md). Those use the
same [non-byte effect lifecycle](NONBYTE-EFFECTS.md), without granting a
guest byte range. Physical shared memory does not make the profile a
multi-task shared address space.

## Tests and limits

Run the native state tests:

```sh
cargo test --locked --manifest-path ricebox/sods/linux/Cargo.toml
```

After building the ordinary Wasm artifact above, run the host boundary
tests from the repository root:

```sh
SODS_LINUX_WASM=ricebox/sods/linux/target/wasm32-unknown-unknown/release/sods_linux.wasm \
node --test ricebox/sods/test/runtime/memory-host.test.ts
```

The [CI workflow](../../../.github/workflows/ci.yml) lists the artifact
and environment settings for translated startup, real Workers, and the
separate output-role tests. Raw ABI controls test stale or malformed
receipts; they are not evidence of physical Worker stop. Passing these
tests is not browser, Workerd, full Linux, terminal, or default-runtime
compatibility.

Capacity settings bound logical records and initialized ranges, not all
allocator consumption. The root, mount, and action tables use bounded
lookups. Startup uses separate artifact, translator, Core, and guest
memory, so validation and copying still cost work. Consult the linked
contracts for measured scope; they do not claim allocation or performance
optimality.
