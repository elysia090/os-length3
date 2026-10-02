# Compiler boundary checkpoint — 2026-10-02

Build through `make -C src/v2 wasm-compiler` so the ordinary ELF reader,
support library and machine ABI providers finish before the product links.
`make -C src/v2/wasm-compiler check` checks interface rejection, not executable
Wasm lowering. The public CLI is now included in `all`.

## Rejected reopen invalidates an accepted image

Before the fix, opening invalid ELF bytes returned a proof error while the
compiler retained the previous borrowed image and counts. The poisoned-state
regression failed on all four clearing assertions. `wasm_compiler_open` now
constructs a temporary candidate and clears the complete compiler on failure.

The same regression also passes with a genuinely admitted image from the
published bundle, followed by malformed and NULL input. C ASan/UBSan and leak
detection pass on that test. The input is:

```
release:       os-length3-linux-v0.1.0-rc.1
publication:   1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195
path:          root/bin/busybox
ELF SHA256:    62a1aa4720607ec8c3ec38c50041cc7ff3dae9e29ebd335b589283c8e0381212
```

After authenticated bundle extraction, reproduce with:

```
make -C src/v2 wasm-compiler
make -C src/v2/wasm-compiler accepted-input-check INPUT=/absolute/path/root/bin/busybox
```

The observed result is:

```
Accepted ELF -> rejected reopen: green
Wasm compiler admission: green (not executable projection)
```

## Executable projection is still red

Run the separate product gate against the same input:

```
make -C src/v2/wasm-compiler projection-check INPUT=/absolute/path/root/bin/busybox
```

The proof-bearing optimized ELF opens, then emission returns `-104`:

```
wasm-compiler: executable lowering is not implemented; no module was published
wasm-compiler: refused input (-104)
executable Wasm projection: red (compiler did not emit)
```

Do not mark this red gate green with a valid module header, the small browser
fixture, or source proof counts. Those counts are not decoded optimized-x86
block boundaries or a Wasm coverage proof. Complete executable lowering and
machine-ABI differential execution must be connected first. Neither the
native bundle nor the human UI was changed by these boundary checks.
