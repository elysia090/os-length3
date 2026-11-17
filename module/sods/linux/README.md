# Linux execution domain

This crate is the initial internal migration unit for Rust-owned Linux semantics.
It is separate from the x86-64 translator (`../src`) and regular-file payload
storage (`../file-store`). It is not a general-purpose `core` directory.

Currently only the private single-action lifecycle is implemented. It consumes
permission before host execution, retains uncertain completion, accepts cumulative
prefix evidence, and refuses stale/duplicate actions. `Completion::Stopped` requires
both no further effects and ended access; a confirmed byte count alone does not.

The domain allocator, real host admission table, memory leases, encoded Wasm ABI,
Linux operations and caller migration are **not connected yet**. Consequently this
crate does not replace the TypeScript runtime, enforce host memory safety, or thin
production TS today. Dead-code warnings reflect that incomplete integration.

A future domain must own exactly one sequence issuer for its unique domain ID.
Each pending operation owns its action and backing/reservation obligations; dropping
this Rust record alone is not permission to release backing. Host callbacks must
not start before `start` succeeds, and a thrown/unknown operation is never reissued.
No completion here proves that other owners or an entire domain can be freed.

Local, dependency-free state tests:

```sh
cargo test --offline --manifest-path module/sods/linux/Cargo.toml
```

These tests do not validate a real Worker, shared-memory observation, browser,
translator artifact, or Linux guest. The next integration must test those actual
boundaries rather than treating this state machine as a usable runtime.
