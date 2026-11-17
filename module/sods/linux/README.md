# Linux execution domain

This crate is the initial internal migration unit for Rust-owned Linux semantics.
It is separate from the x86-64 translator (`../src`) and regular-file payload
storage (`../file-store`). It is not a general-purpose `core` directory.

The private single-action lifecycle and bounded memory-admission table are implemented. It consumes
permission before host execution, retains uncertain completion, accepts cumulative
prefix evidence, and refuses stale/duplicate actions. `Completion::Stopped` requires
both no further effects and ended access; a confirmed byte count alone does not.

The private wasm32 ABI connects that table to `runtime/linux/memory-host.ts`, which
creates and retains actual engine memories without exposing raw memory or callbacks.
Capture/write/grow operations acquire admission before host access. Mutation reserves
exclusively before execution; successful retirement publishes a new binding identity.
Unknown completion keeps the obligation and consumes bounded capacity. A memory
binding is domain-local, not a process identity; ordinary guest writes are not locked.

This is **not yet connected to Linux guest execution or the public runtime**. The
translator import/operator validation, exec/restore/Worker bindings, full domain
allocator and caller migration remain absent. No claim of end-to-end guest lifetime
safety or production TS thinning follows from the adapter. Host artifact checks only
check import/export shape; they do not validate arbitrary module behavior.

Memory/action limits allocate bounded records at initialization. Lookups are bounded
linear scans, O(M + A), not claimed constant-time or optimal. Capture makes one owned
snapshot; write first captures caller bytes then stores them, adding a copy versus a
proved direct source. Grow serializes against active spans. Memory unbind is absent,
so a domain refuses new bindings at its limit rather than growing indefinitely.
Unexpected host exceptions conservatively quarantine the action/binding; no recovery
or automatic retry is claimed. A finished byte count never alone permits release.

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

Private ABI integration test with an explicitly built artifact:

```sh
cargo build --offline --target wasm32-unknown-unknown --manifest-path module/sods/linux/Cargo.toml
SODS_LINUX_WASM=<path-to-sods_linux.wasm> node --test module/sods/test/runtime/memory-host.test.ts
```

The real-engine tests cover shared and unshared memory objects, not concurrent guest
writers or cross-Worker visibility. Missing artifact skips those tests explicitly.
