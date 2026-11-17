# sods portable execution core

A dependency-free Rust unit for the portable execution-core migration. It does not
require ricebox, an OCI bundle, a desktop session, or the translator crate.

The first implemented module, `byte_effect`, specifies and checks the proposed
private v1 96-byte byte-effect record and once-only copy completion. It is not a
public kernel protocol. `validate_backing_bounds` checks arithmetic against supplied
extents, not guest mapping permissions or live allocations. Completion records must
be scoped to the owning core instance by the eventual integration.

The running TS kernel is **not yet connected** to this unit. The opt-in file-payload
slice below has a real TS/Wasm connection; kernel allocation leases, mapping pins,
host callbacks, syscall execution and Worker lifecycle are not implemented here. No stub claims success for them. Native unit tests do not establish
Wasm ABI compatibility, runtime memory safety or a performance improvement.

Run the focused checks with an existing Rust toolchain:

```
cargo test --manifest-path module/sods/core/Cargo.toml --locked --offline -j 1
```

## First connected slice: owned regular-file payloads

`files` implements create/read/write/truncate/close in Rust. The opt-in
`runtime/core/files.ts` facade calls the actual Wasm exports and returns independent
byte snapshots. It does not replace `Vfs` or the running kernel's `File`: namespace,
permissions, descriptors, lazy loading and MAP_SHARED propagation remain unported.
No guest execution memory is touched, so mapping-pin enforcement and the proposed
96-byte effect ABI are not claimed by this slice.

A caller supplies a trusted matching core module and an explicit per-file length
limit, then owns each returned handle until `close()`. Close is idempotent; IDs are
not reused. Dropping the store/handles permits the instance to be collected, not a
synchronous reclamation guarantee. Empty ID-table slots and scratch capacity can be
retained, so the limit is not a total-memory bound. Input snapshots, scratch import,
Rust file storage and output snapshots have explicit copy/retention costs; no
zero-copy or performance claim is made.

```
const files = await loadCoreFiles(module, 1024 * 1024);
const file = files.create(new TextEncoder().encode('hello'));
file.write(5, new TextEncoder().encode('!'));
const snapshot = file.read(0, 6);
file.close();
```

Build/test with an already-installed wasm32 target (no automatic installation):

```
cargo build --manifest-path module/sods/core/Cargo.toml --target wasm32-unknown-unknown --locked --offline -j 1
SODS_CORE_WASM=module/sods/core/target/wasm32-unknown-unknown/debug/sods_core.wasm node --test module/sods/test/runtime/core-files.test.ts
```

The integration test is explicitly skipped without its artifact variable. A skipped
case is not evidence that the Wasm integration passes. Scratch views are private
and only valid until the next export; callbacks and asynchronous effects are absent
from this first slice. Raw exports are not a supported safe embedding API.

Compatibility details: these are File **payload primitives**, not Linux read/write
syscalls. Like the inspected TS File.write primitive, an empty write beyond EOF
extends with zeros; syscall-level zero-write rules must be applied by a future
kernel layer. The configured length limit is checked on that operation too.

Current copy paths are caller → owned JS snapshot → core scratch → file payload
for create/write, and file payload → core scratch → owned JS snapshot for read.
These are deliberately conservative first-integration costs, not minimal copies.
The facade checks the input byte length before snapshotting and again afterward;
this is not a quota against arbitrary hostile embedding objects or allocations.

Use an artifact built from the same matching crate revision. The v1 export check
rejects unknown versions but is not code authentication or exhaustive export/schema
validation. This API is not a sandbox for arbitrary supplied Wasm modules.
