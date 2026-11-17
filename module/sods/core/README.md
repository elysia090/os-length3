# sods portable execution core

A dependency-free Rust unit for the portable execution-core migration. It does not
require ricebox, an OCI bundle, a desktop session, or the translator crate.

The first implemented module, `byte_effect`, specifies and checks the proposed
private v1 96-byte byte-effect record and once-only copy completion. It is not a
public kernel protocol. `validate_backing_bounds` checks arithmetic against supplied
extents, not guest mapping permissions or live allocations. Completion records must
be scoped to the owning core instance by the eventual integration.

The running TS kernel is **not yet connected** to this unit. Exported allocation,
mapping pins, host callbacks, syscall execution and Worker lifecycle are not
implemented here. No stub claims success for them. Native unit tests do not establish
Wasm ABI compatibility, runtime memory safety or a performance improvement.

Run the focused checks with an existing Rust toolchain:

```
cargo test --manifest-path module/sods/core/Cargo.toml --locked --offline -j 1
```
