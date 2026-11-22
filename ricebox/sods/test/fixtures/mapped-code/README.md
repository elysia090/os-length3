# Mapped-code backend proof

Build the current translator with the non-default `mapped-code` feature:

```sh
cargo build --manifest-path ricebox/sods/Cargo.toml --locked --release \
  --target wasm32-unknown-unknown --lib --features mapped-code
SODS_TEST_MAPPED_WASM=PATH_TO_CURRENT_SODS_WASM \
  node --test ricebox/sods/test/runtime/mapped-code-current.test.ts \
    ricebox/sods/test/runtime/mapped-vm.test.ts
```

The assembly objects are CPU-backend fixtures, not interpreters or
application launchers. They prove cross-object register and table use,
warm lookup reuse, and refusal of old or foreign executable extents.
`resume.S` directly exercises the existing Linux `mprotect` and
`exit_group` syscall handlers from translated code, including resumption
after a nested Wasm frame is retired. It is not a guest exec test.
The VM tests also exercise checked copies through the ordinary file
and console syscall paths, including protection changes and callback
lifetime. `data.S` then uses the same VM regions for actual translated
scalar, stack and vector operations. Set `SODS_MEASURE_MAPPED=1` to
report the checked-loop timing in the local Node test. It is not an
application or browser benchmark.

Set `SODS_TEST_DYNAMIC_ROOT` to the separate [authenticated PIE and
DSO fixture](../dynamic/) to additionally validate biased code generated
from that app, its Debian interpreter, and DSO. The VM test uses actual
private file mmap of the fixture DSO and the pinned Debian libc. No code
from that application, libc or its interpreter runs in this proof.
Linux exec, profile admission and browser Worker defaults are unchanged.
