# sods file store

Owned regular-file payloads, lazy-load state and read leases. This independent,
dependency-free Rust crate is **not** a kernel, filesystem namespace or generic
platform layer. It can be tested natively and built as a Wasm library without the
translator or ricebox.

## Layout and dependency direction

```
file-store/
  Cargo.toml
  Cargo.lock
  README.md
  src/
    lib.rs             crate boundary
    store.rs           canonical bytes, file IDs, loading and residency
    read_lease.rs      one outstanding scratch-read completion
    wasm.rs            Wasm exports; no imported host capabilities
  docs/
    ownership.md       current lifetime obligations and unclosed gates
    costs.md           operation measurements and their conditions
```

The adjacent runtime layers have different responsibilities:

- `runtime/file-store.ts`: Wasm ABI validation, owned snapshots and host loader
  capabilities. No Node/browser detection, Linux errno, Vfs or distribution imports.
- `runtime/linux/file-scope.ts`: Linux File/Vfs, errno and shared-mapping integration
  plus explicit finite-scope ownership.
- `runtime/host.ts`: host capabilities such as threads, clocks and storage. This is
  not the guest Linux ABI; Linux guests run under Node or browsers too.
- ricebox `build/file-store-artifact.ts` and `runtime/file-store.ts`: respectively artifact
  generation/selection and verified release consumption. Integrity/distribution
  policy does not belong in this crate or the portable Wasm binding.

A new host does not add branches to this store. It must implement the host resources
its runtime needs; a different guest ABI would need its own adapter to the same
payload semantics where those semantics actually match. No empty `platform` or
catch-all `core` hierarchy is introduced in anticipation of future platforms.
The previously unconnected 96-byte byte-effect proposal is removed from the crate;
its own tests did not establish runtime integration. The **used** read-lease module
remains. Earlier experiments are recoverable from Git history, not public runtime APIs.

## Consumer entrance

The existing `sods/linux` package entrance re-exports `prepareFileStore`,
`loadFileScope` and `FileScope`. It does not require a new package entrance.

```ts
const module = await prepareFileStore(trustedWasmBytes, 1024 * 1024);
const scope = await loadFileScope(module, 1024 * 1024);
const vfs = scope.createVfs();
const file = scope.writeFile(vfs, '/hello', new TextEncoder().encode('hello'));
const snapshot = file.bytes();
// Run all consumers, hand off their results, and establish their termination.
// Only the sole owner of the complete finite graph may then dispose it.
scope.dispose();
// snapshot remains owned by this caller; File/Vfs use is no longer valid.
```

`prepareFileStore` checks an explicitly selected trusted artifact using the consumer
ABI and a temporary empty-file smoke operation. It is not a sandbox or an integrity
verifier. `loadFileStore` is the lower-level binding used by the Linux adapter;
`loadFileScope` owns all payloads created through its chosen Vfs until disposal.
No artifact is downloaded or chosen implicitly.

Scope-created regular files participate in existing pathname/open/read/write,
lazy pack loading, truncate and mapping operations. Legacy default Vfs payloads,
devices, FIFOs, memfd and shared-anonymous mmap are not silently converted. Normal
Kernel state, descriptors and guest memory still live in TS. A finite caller must
outlive every kernel, mapping, image, callback and embedding user of the scope.
Unlink or fd close is not proof of inode death. No automatic long-lived collection
or aggregate memory budget is claimed. `maxFileBytes` is a logical per-file limit.

## Public selection names and pre-release migration

This PR introduced the previous `fileCore` selection; it was not in main and has
not been released to a registry. The current names are `fileStore`,
`prepareFileStore`, `--file-store`, `--file-store-limit`, and
`SODS_FILE_STORE_WASM`; the crate output is `sods_file_store.wasm`.

Prepared indexes, JS configs/messages and CLI arguments using the old selection
name are rejected explicitly, including null values and old/new mixtures. They
must be regenerated with the current builder and matching consumer. They must not
silently fall back to TS payloads. Existing releases that never selected a Rust
store remain supported. There is no compatibility alias or reinterpretation of
an old selected artifact. This is a deliberate pre-release migration, not proof
that an old local fixture already uses the new schema.

The Wasm operation ABI remains version 4 with its existing `files_*` exports.
Names/layout do not change its payload or completion semantics.

## Verification

With an existing Rust toolchain and installed wasm32 target:

```sh
cargo test --manifest-path ricebox/sods/file-store/Cargo.toml --locked --offline -j 1
cargo build --manifest-path ricebox/sods/file-store/Cargo.toml \
  --target wasm32-unknown-unknown --locked --offline -j 1
SODS_FILE_STORE_WASM=ricebox/sods/file-store/target/wasm32-unknown-unknown/debug/sods_file_store.wasm \
  node --test ricebox/sods/test/runtime/file-store.test.ts
```

The actual-Wasm suites also cover Linux scope integration, lazy-load reentry,
publication/offset failures, retained aliases and resource accounting. Without an
artifact environment variable they skip; a skip is not execution evidence.
`ricebox/sods/make/npm.test.ts` exercises a packed independent consumer with real
ELF execution, copied results and finite Node shutdown. It needs a separately
selected translator artifact and does not prove a current-source full distribution.
Browser and everyday/Wayland execution remain separate verification gates.
