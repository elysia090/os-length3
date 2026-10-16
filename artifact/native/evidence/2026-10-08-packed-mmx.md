# Shared packed/MMX closure — 2026-10-08

Same native publication and human UI. One x86 descriptor -> ordinary Wasm ->
C MMU/table path; no guest ISA interpreter, numeric VM callback or source skip.

## Shared lane law, separate architectural boundary

Bitwise AND/OR/XOR/AND_NOT, lane add/subtract/equality/signed-greater,
signed/unsigned saturating add/subtract, min/max, unsigned rounded average and
low-word multiplication now share the same operator/lane/alias law for MMX64
and XMM128. MMX's formerly ambiguous split operator codes are normalized to
the common packed operation coordinates. The backend does not recover source
mnemonics or choose another scalar evaluator.

The backend emits the corresponding Wasm SIMD operation and low64 publication
for MMX; no scalar lane array is formed. Equal inputs substitute constant
zero/ones or identity when exact. MMX identity still has architectural effects:
it marks occupancy and updates destination sign/exponent/TOP, not a pure no-op.
SSE retains its own #UD/#NM guards; MMX has EM #UD, TS #NM, and shares the
existing pending x87 exception/FERR owner before memory access.

MMX/XMM memory widths remain8/16, with one complete rights/residency preflight
before publication. MOVD/MOVQ/MMX register/GPR/memory transfers share the scalar
transfer path; narrow GPR writes define the parent, MMX writes clear the unused
upper portion as required. MOVNTQ uses the new generic8-byte alignment flag in
C preflight AFTER FS/GS base normalization, not a separate backend EA check.
The serialized single-owner projection has no outstanding guest store buffer.

Canonical SIMD binary encodings are taken from the primary
[WebAssembly SIMD specification](https://raw.githubusercontent.com/WebAssembly/simd/main/proposals/simd/BinarySIMD.md).
This is an execution spelling, not an optimal native instruction certificate.

## Full-tag observations are not occupancy guesses

The existing FPU hardware capture now also records FNSTENV's saved full tag
and actual RAX. CW is restored before the measured instruction; AFTER is
captured before environment masking. FXSAVE's abridged occupancy is not silently
substituted for a saved full tag. A separate tag-before-FXSAVE control gives
the same tag words as tag-after-FXSAVE; the mismatch is not hidden as a capture
ordering effect. Normal/empty/TOP/payload classes vary across samples.

MMX makes all slots occupied. The saved full-tag representation additionally
reflects payload classes: zero, normal, special. Writing a literal0 did NOT
match the independent records. The emitter instead obtains integer-bit and
zero-significand bitmaps from four physical SIMD pairs, and zero/full-exponent
bitmaps from one exponent column. Two8-bit maps are spread into16-bit tag
coordinates with fixed shifts/masks. No FPU register array rotation, full-state
copy, scalar lane reconstruction or untrusted guest-memory load is added.
The internal CPU reservation supplies these fixed columns. Deferring this
derived saved view further is future work; global minimum/work/span is not claimed.

## Verified populations

| Population | Forms/modules | Independent native rows |
| --- | ---: | ---: |
| MMX33 binary operations | 891 | 28,512 |
| XMM33 same binary operations | 1,485 | 47,520 |
| MOVD/MOVQ/MOVNTQ transfer forms | 60 | 1,920 |

All77,952 rows pass actual cold C -> Wasm -> C-MMU/table complete-state
comparison. RAX is physically captured for transfers; other GPR invariance
there is architectural. Tagged FPU images, all XMM registers, flags and affected
memory are observed. Prepared CR4 has PAE and, for XMM, OSFXSR; these are
test-context inputs, not privileged host register measurements.

Shared constructors: **11,352** MMX/XMM forms / **90,816** unchanged malformed
refusals. Transfers: **1,232** forms / **9,856** malformed refusals. C guard
models add168 #UD/#NM/#MF and24 complete zero-state successes. C FS-before-
alignment models distinguish aligned final addresses with unaligned EAs from
unaligned final addresses with aligned EAs, preserving all CPU/data on fault.
These C models are not mislabeled as physical hardware observations.

VM/x86/compiler/postlink and positive ASan/UBSan gates pass without warnings.
Existing FILD12,288, register arithmetic42,624, IEEE load6,144 and integer
store24,576 hardware records remain regression inputs, not rewritten expected
values. Old tests asserting refusal of the now-supported MMX transfers now
assert typed admission; actual #UD and remaining grammar refusals remain.

## Measurements and remaining goal

Actual make, same233,455 PF_X-byte domain: **1,389 ->1,277 ->1,031 unresolved**,
**358 recovered** (356 MMX/x87-family and2 packed vector coordinates).
Lowerable232,424; fault/fetch/capacity refusals0. First cd04 at0xa917 is generic
software interrupt work, not permission to skip it. Complete-bundle ZERO and
actual browser Linux acceptance remain active; no incomplete root is published.

Compiler667,848 bytes, SHA256
`58fd3de8a78bbba8d901c4789737af6f87fa4da1928abea3d1e1983ea3243765`;
VM98,106 bytes, SHA256
`f8821cea6eb71694a08ab547fb110404713ba71644b424dc2db9e69b566b9a3d`.
Source-scope builds, not new signed Linux delivery or browser boot/speed proof.

## Reproduction

```sh
make -C src/v2/wasm-compiler packed-binary-check mmx-transfer-check
OBSERVER NEW-MMX-RECORDS
OBSERVER NEW-XMM-RECORDS --wide
OBSERVER NEW-TRANSFER-RECORDS --transfer
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM MMX-RECORDS --mmx
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM XMM-RECORDS --packed
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM TRANSFER-RECORDS --mmx-transfer
node data/oracle/check-x87-fault.mjs VM.WASM COMPILER.WASM --mmx
node data/oracle/check-mmx-alignment.mjs VM.WASM COMPILER.WASM
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Observer source: mmx-binary-observe.c uses the existing hardware capture, not
the product compiler or arithmetic implementation. Ignored receipts under
temp/mmx-1008 are test data, not distribution payloads.
