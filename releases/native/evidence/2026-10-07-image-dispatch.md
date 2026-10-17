# Bounded complete ELF code dispatch — 2026-10-07

The `a79dc4e` ordinary CLI accepts the proved ELF below but returns -104,
despite all six FINAL PF_X coordinates being admitted by the actual backend.
The archived native compiler was built and run against that same file: no
module was published. Its cold C export for image generation is absent.
This separates the old missing generation route from ISA coverage gaps.

## Product connection

`emit-module.c` reads actual final executable PT_LOAD maps, including interior
coordinates and zero-fill extents. Proof/source function counts cannot stand
in for those addresses. Each coordinate is admitted by the existing one-cut
frontend and emitter. All coordinates must lower before publication; a valid
grammar miss or incomplete fetch context is not converted to #UD/#PF.

The same shared-import, virtual-body quotient and single output owner produce
the unique functions. `emit-dispatch.c` emits an ordinary Wasm binary-search
decision tree and direct module-local calls, not an operation stream or guest
interpreter. With E the exact sorted source coordinate set and b the loader's
immutable bias, the entry contract is

    key = admitted_entry - b  (i64 modular arithmetic)
    key in E: call body[class(key)](state, port, admitted_entry, binding(key))
    key not in E: return ENTRY_MAP, with no CPU mutation.

It imports immutable `machine.image_bias : i64` and exports `entry` with the
existing machine-entry ABI 3 type. The fourth entry argument is ignored: the
dispatcher supplies the constant binding derived by the compiler for that
source coordinate. Ordinary cut exports keep their separately attested binding
contract. The typed import mapping and existing callback semantics are shared.
Mutable bias imports are refused by the engine's Wasm type validation.

The loader still owns authenticated source/generation, actual executable
mapping, MMU/debug/CPU context and the instance's immutable bias lifetime.
Executable relocations require a new admitted source generation. A numeric
bias is NOT a relocation engine, an authorization proof or a Linux ABI layer.
The code domain's external successor is resolved by the existing machine
owner; an out-of-domain result is not an automatic fault or execution fallback.

The current collector handles the ENTIRE domain only if it fits <=256 source
coordinates / <=64 KiB, with body definitions plus dispatcher under the
caller's function cap. It never drops entries to fit. Larger domains still
refuse -104 until streaming multi-module/directory production is connected.
The actual published `/usr/bin/make` does so; no output is published.
This is a main remaining blocker, not success for the Linux bundle.

## Actual inputs and observations

The fixture goes through normal assembly/link -> the independent postlink CLI
-> postlink-verify -> the ordinary Wasm compiler. Inspect FINAL code: an early
NOP/flag fixture shrank 39 bytes to one. An infinite-jump fixture shrank to two
bytes, leaving an interior truncated fetch; -105 must remain a source-context
obligation rather than an invented architectural fault. The accepted fixtures
below have no such coordinate gap. ET_DYN uses a genuine cross-section static
construction relocation; its standard loader metadata/proof is not fabricated.

Receipt:

- ET_EXEC: 6 coordinates, 5 unique bodies + one dispatcher, 2,024 bytes.
- ET_DYN: 11 coordinates, 7 unique bodies + one dispatcher, 2,777 bytes.
- Native/cold image bytes are exact. Every final PF_X coordinate is compared
  through C source admission/MMU/table execution against the frozen standalone
  compiler with three biases (zero, low positive, high-half), CPL 0/3 and
  readwrite/readonly/absent RAM. 108 + 198 = 306 comparisons.
- 18 out-of-domain calls preserve the full CPU reservation. Mutable bias
  imports fail to link. Five C capacity/definition-cap/alias refusals preserve
  output/report/written, and bytes beyond the final output remain untouched.

The comparison oracle is the frozen C compiler with the same actual C provider,
not an independent hardware ISA proof for every interior coordinate. Existing
native cut observations, full compiler/VM regressions and scoped ASan/UBSan
remain green. The revised `projection-check` invokes the executable comparator
rather than hardcoding red after checking the magic. Its Node environment is
explicitly one source page; it refuses unsupported test environments and is
not signed production admission. The host comparator ran; the shell wrapper
was syntax checked (the reference build guest has no Node installed).

The same published native bundle's short Node startup preserves the complete
86-instruction observation and 1,617,931 retirements, then the unchanged quota.
That diagnostic still uses fresh source cuts, NOT the completed Linux image
directory. No new actual-browser run, shell success, distribution size/speed,
RSS bound or renderer-crash recovery is claimed. Native publication/UI stay
unchanged, and the goal's offline development/storage/granted-network gates
remain unfulfilled.

```text
make -C src/v2/wasm-compiler image-path-check
LENGTH3_IMAGE_INPUT=VERIFIED-IMAGE.elf make -C src/v2/wasm-compiler segment-sanitizer-check
wasm-compiler VERIFIED-IMAGE.elf IMAGE.wasm
node data/oracle/check-image-dispatch.mjs VM.wasm COLD.wasm FROZEN.wasm VERIFIED-IMAGE.elf IMAGE.wasm
```

Next: produce the complete large-image coordinate/control directory as bounded
ordinary modules through the existing Artifact index, refuse all genuine ISA /
source-context gaps, and connect authenticated C image admission/residency.
An observed prefix, partial root, larger cache quota or another interpreter
does not discharge that obligation.
