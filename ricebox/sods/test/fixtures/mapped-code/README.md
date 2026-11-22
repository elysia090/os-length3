# Mapped-code backend proof

Build the current translator with the non-default `mapped-code` feature:

```sh
cargo build --manifest-path ricebox/sods/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown --lib --features mapped-code
SODS_TEST_MAPPED_WASM=PATH_TO_CURRENT_SODS_WASM \
  node --test ricebox/sods/test/runtime/mapped-code-current.test.ts
```

The two assembly objects are CPU-backend fixtures, not interpreters or
application launchers. They prove actual cross-object register and table
use, warm lookup reuse, and refusal of old or foreign executable extents.
They do not replace the Linux syscall layer.

Set `SODS_TEST_DYNAMIC_ROOT` to the separate [authenticated PIE and
DSO fixture](../dynamic/) to additionally validate biased code generated
from that app, its Debian interpreter, and the DSO. No code from that
application runs in this proof. Linux exec, profile admission and browser
Worker defaults are unchanged.
