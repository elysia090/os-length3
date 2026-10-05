# Precise byte shuffle without scalar lanes — 2026-10-05

The completed final packed-add run actually passes PADDD and reaches
`pshufb %xmm12,%xmm3`, bytes `66 41 0f 38 00 dc`, at
0xffffffff81204e36: [actual receipt](2026-10-05-node-startup-pshufb-red.json).
162,943,231 source instructions retire / 88,109,844 admissions; all
14,622,864 decompressed bytes match the independent gzip oracle. This is an
independent Node run of the real shipped kernel, not a browser/PID 1/shell
receipt. Native bundle and human UI remain unchanged.

## Derivation before implementation

[Red first](2026-10-05-vector-shuffle-red.log): the independent native oracle
captures 33,792 CPU/RAM records / 15,248 fault frames, but the old common
compiler rejects new form 256 with grammar -102. These eight new forms cover
distinct registers, self-alias and six memory-address topologies, with high
XMM registers. The original 256 forms remain in the same test population.

Intel [SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B PSHUFB (PDF pages 429–432, zero-based), specifies legacy 128-bit
selection: selector bit 7 zeroes the result; bits 3:0 select an OLD destination
byte; bits 6:4 are ignored. A memory selector has the complete aligned
16-byte/type-4 fault boundary. Flags and numeric FP state do not change.
The frozen `x86/profile.h` already advertises CPUID.1:ECX bit 9 (SSSE3);
the decoder/profile is not widened to pass this gate.

Let `A` be the old sixteen-byte destination, `B` the selector vector, and `k`
an output lane. Direct substitution gives:

```text
R[k] = B[k] & 128 ? 0 : A[B[k] & 15]
C[k] = B[k] & 143
R    = i8x16.swizzle(A, C)
```

Proof: if bit 7 is clear, C is exactly the low four bits, hence in [0,15].
If bit 7 is set, C is in [128,143], hence outside [0,15]. Standard
[Wasm swizzle](https://webassembly.github.io/spec/core/exec/numerics.html#op-ivswizzle)
returns zero for every out-of-range selector. Thus the substitution is exact
for all 256 selector values, not a mask observed at one kernel address.
Relaxed swizzle is deliberately excluded because its out-of-range behavior
can differ. Encodings follow the official
[SIMD binary table](https://raw.githubusercontent.com/WebAssembly/simd/main/proposals/simd/BinarySIMD.md).

The pure network is two vector operations, dependency depth two, with operands
and mask available. This excludes admission, operand acquisition, constants
and publication. It is not a global work/span minimum or native speed claim;
native x86 already has one PSHUFB instruction. No sixteen-byte intermediate
image, sixteen-lane runtime loop, host guest-memory callback or new VM opcode
handler is added. Old vectors live on the Wasm operand stack. The complete
result is stored only after the existing control and memory frontier passes.

The C pair port's low/high words are noncontiguous: memory input is assembled
with i64x2.splat/replace_lane, never a v128.load across its fault fields.
The first generated-memory-body check caught a wrong i64 local used as a port
address (Wasm type validation red); it is corrected to the actual i32 port
parameter. Native/cold byte parity alone cannot validate generated stack types.

## Verification

[Comparison receipt](2026-10-05-vector-shuffle-comparisons.json): 264 exact
native/cold emissions; 33,792 unchanged pre-lowering native records; 33,792
direct and 33,792 C-dispatch CPU/RAM comparisons; 67,584 RF checks; 60,992
native fault comparisons; 3,696 control-priority models; 676 waits/retries;
3,568 entry refusals; 128 alias cases; 14 pair refusals pass. All 16,384
selector-value/lane/distinct-or-alias/direct-or-dispatch models execute the
actual emitted bodies. Each uses a byte-copy reference, not the emitted
mask/swizzle formula. These extra models are not native records.

The emitted bytes are checked for the single vector mask/swizzle/publication
network, preventing a silent sixteen-scalar-slice substitute. The required
SIMD-unavailable engine-boundary model propagates CompileError, makes exactly
one construction attempt, publishes no witness, and leaves CPU, RAM and the
installed table slot unchanged. It is an explicit model, not a feature test
on a particular browser. No scalar/native/interpreter alternative is selected.
Full native compiler checks/CLI and scoped compiler ASan/UBSan pass.

All previous 256 source pages, native case populations and generated modules
are byte-identical. MOVD/MOVQ scalar, MXCSR, borrowed source/output growth,
bounded engine lifetime and construction regressions pass. The matched
no-image one-million-admission startup preserves every non-size/non-clock/
timing observation. Native observations run in the independent WHPX build
guest; Node executes the C-Wasm provider, not Linux via QEMU.

Register modules are 404 bytes; the six memory forms are 474–491 bytes.
The final compiler is 444,763 bytes (+645 from packed-add), SHA-256
`0b7f421d718208b97ec49699d68ae5c79d84a9dd0c6f7039f42ad0678287993c`.
The unchanged VM is 63,052 bytes, SHA-256
`a0bb464e8f4d3bd47e9dbc12fe84ac111cb9e9ad9a52d190be67a3f615cb814c`.
Provider/compiled-body imports stay C machine ABI only; shared memory,
isolation, relaxed SIMD, memory64 and a JavaScript guest callback are not
introduced. Standard Wasm SIMD is now an explicit projection requirement;
it does not change native distribution dependencies.

Reproduce with fresh output directories (native compiler and libraries built
as documented in the compiler checks):

```sh
make -C src/v2/wasm-compiler check
mkdir temp/vector-observed temp/vector-emitted
src/v2/wasm-compiler/build/vector-transfer-check temp/vector-observed --observe
src/v2/wasm-compiler/build/vector-transfer-check temp/vector-emitted
make -C src/v2/wasm-compiler wasm
node data/oracle/check-vector-transfer.mjs VM.wasm COMPILER.wasm temp/vector-emitted temp/vector-observed
node data/oracle/check-wasm-startup.mjs VM.wasm COMPILER.wasm BUNDLE-PREFIX-DIRECTORY --extended --progress --segments=INDEPENDENT-SEGMENT-FIXTURE --image=IMMUTABLE-SYSTEM-IMAGE
```

The final compiler is running on the same published bundle with independent
segments/root-image fixtures; do not restart/overwrite it. Actual PSHUFB
execution, next gate and PID 1/shell remain to be observed. In the preceding
completed run, 16,241,866 engine constructions / 16,241,123 quota evictions
dominate: engine 404,371.7 ms, cold 160,874.0 ms, execution 90,695.6 ms,
admission 21,676.8 ms, supply 208.3 ms, elapsed 816,594.3 ms. Copied code bytes
are zero; Memory is 20,512,768 bytes. Calibration/work variation prevents a
speedup claim. Region/topology closure, cold shell 3s, browser acceptance,
PID 1, development commands, authenticated storage/recovery and granted
network remain open. Strict CALL and Windows RTC oracle reds remain open.
