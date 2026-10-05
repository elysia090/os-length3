# Logical packed shifts by substitution — 2026-10-05

The completed final byte-shuffle startup actually passes PSHUFB and reaches
`psrld $12,%xmm1`, bytes `66 0f 72 d1 0c`, at 0xffffffff81204e49:
[actual receipt](2026-10-05-node-startup-psrld-red.json), 161,593,710
retirements / 87,316,980 admissions. All 14,622,864 decompressed bytes agree.
This is a real shipped-kernel Node run, not browser/PID 1/shell acceptance.
Native delivery and human UI are unchanged.

## General derivation, before implementation

[Red first](2026-10-05-vector-shift-red.log): the native oracle records 46,080
CPU/RAM observations / 15,248 fault frames; the old common compiler rejects
new form 264 (PSRLD count zero) with grammar -102. Six families cover 16/32/64
bits and both logical directions, each with 16 native count cuts including
0, 1, 12, 20, width-1, width, width+1, 127 and 255 across the population.
The old 264 forms remain unchanged. No kernel-address specialization is added.

Intel [SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B PSLLW/D/Q and PSRLW/D/Q (zero-based PDF pages 450–455, 461,
474–479 and 485), specifies independent logical shifts, zero when the count
is at least the lane width, unchanged flags and no numeric exceptions.
Only immediate legacy XMM forms are newly admitted; variable-count, MMX,
arithmetic, byte-vector shifts and VEX/EVEX forms are not implied covered.
The existing decoder and fixed CPU profile are unchanged.

For each lane value x, width w in {16,32,64}, and unsigned immediate n:

```text
logical_right(x,n,w) = n >= w ? 0 : x >> n
logical_left (x,n,w) = n >= w ? 0 : (x << n) mod 2^w
```

The count is an admitted source immediate, not a runtime guest register.
Substitution partitions it before generating a body:

```text
n == 0     -> identity: no old XMM read and no XMM publication
0 < n < w  -> one standard i16x8/i32x4/i64x2 vector logical shift
n >= w     -> constant zero: no old XMM read, one vector publication
```

This distinction is necessary because
[Wasm shifts](https://webassembly.github.io/spec/core/exec/numerics.html#op-ishl)
reduce the count modulo the element width. The nonzero admitted counts are
strictly below w, so the direct vector instruction has exactly x86 meaning.
The zero and identity cases eliminate the runtime operation instead of
adding a runtime branch or relying on modulo wraparound. The SSE control
frontier still executes before all three cases; successful RIP/RF/retirement
remain in the common epilogue. No x86 instruction is skipped or falsely retired.

The zero branch initially used two i64 stores, emitting 381-byte modules.
One zero i64x2.splat plus one vector store emits 372 bytes and has no output
image. The regression budget is <=375 bytes, so the earlier two-store form
is red. Identity emits 361 bytes, other shifts 380 bytes. Structural checks
also require the single vector shift/store network or absence of XMM work.
Pure shift work/depth is one when operands/count are available; the other
two cases have no pure shift operation. This excludes admission, constants,
acquisition and publication, and is not a global/native speed/minimum claim.

## Verification and actual run

[Receipt](2026-10-05-vector-shift-comparisons.json): 360 exact native/cold
emissions; 46,080 unchanged pre-lowering native observations; 46,080 direct
and 46,080 C-dispatch CPU/RAM comparisons; 92,160 RF checks; 60,992 native
fault comparisons; 5,040 control-priority models; 676 waits/retries; 4,720
entry refusals; 128 aliases and 14 pair refusals pass. All 256 immediate values
across six families, four full-word patterns and direct/dispatch routes give
12,288 further comparisons. They compile and execute the actual generated
body, against an independent per-element model; these are not native records.
The preceding packed-carry/all-byte-add and all-selector shuffle checks stay
green, including the explicit required-SIMD refusal model.

All earlier 264 case populations, source pages and emitted modules are
byte-identical. Full native compiler/CLI checks and scoped compiler ASan/UBSan
pass. Scalar/MXCSR, borrowed-input/output-growth regressions pass. The matched
no-image one-million-admission startup preserves every non-size/non-clock/
timing observation. Actual native observations are in the independent WHPX
build guest; Node runs C-Wasm comparisons, not guest Linux under QEMU.

The final compiler is 445,459 bytes (+696 from byte shuffle), SHA-256
`17faa0a272a558d18b4c387c77c012f7d62a17b98448ea26d02f15a9ecabd272`.
The 63,052-byte VM is unchanged, SHA-256
`a0bb464e8f4d3bd47e9dbc12fe84ac111cb9e9ad9a52d190be67a3f615cb814c`.
The final compiler is running on the same shipped native bundle with the
independent segment/root-image fixtures. Keep that process: actual PSRLD
execution/next gate remain to be observed. Native bundle and human UI stay.
Standard Wasm SIMD is required; relaxed SIMD, a new VM opcode handler,
scalar fallback, source copies and JavaScript guest execution are not added.

Reproduce with the same fresh-directory commands in the
[vector checkpoint](2026-10-05-vector-shuffle.md). All success conditions
remain: browser boot/PID 1, offline development commands, authenticated
storage/recovery and granted network. Cold shell 3s, repeated engine/source
reconstruction and complete ISA/ABI coverage are still open. Strict CALL and
Windows RTC oracle reds remain independent open items.
