# Immediate permutations by coordinate substitution — 2026-10-05

The completed same-bundle immediate-shift run reaches PSHUFD
(`66 0f 70 c0 93`) at 0xffffffff81204eb8:
[actual red receipt](2026-10-05-node-startup-pshufd-red.json). It passes prior
PSRLD/PSLLD and validates all decompressed bytes, not PID 1/browser/shell.

## Derivation before implementation

[Native red](2026-10-05-vector-permutation-red.log) admits no new instruction
in the old compiler. Intel [SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B, PSHUFD/PSHUFHW/PSHUFLW
(zero-based PDF pages 433–442) defines four independently selected elements,
unchanged flags/no numeric exceptions, and full 128-bit memory operands.
Only these three legacy XMM encodings are in scope; MMX/VEX/EVEX and
two-source SHUFPS/SHUFPD/fixed-control duplication are not implied covered.

Let B be the old source vector, c the admitted imm8, w the element width in
bytes (4 for dwords, 2 for words), and h the start of the permuted region
(8 for high words, 0 otherwise). The four output elements are:

```text
R[h + w*j + k] = B[h + w*((c >> (2*j)) & 3) + k]
    0 <= j < 4, 0 <= k < w
R[i] = B[i] outside that region
```

Substituting c before emission gives sixteen fixed byte coordinates, each
in [0,15]. Capture B once in one SSA vector local, use that value twice as
the operands of standard deterministic
[i8x16.shuffle](https://raw.githubusercontent.com/WebAssembly/simd/main/proposals/simd/BinarySIMD.md),
and publish once.
There is one pure permutation operation/depth, not sixteen scalar extracts,
runtime selector computation, a materialized output image or an opcode
handler in the VM. This cost excludes admission/acquisition/publication and
is not a global/native minimum claim.

For c=0xe4 the mapping is identity. Register self-assignment needs no old
payload read/publication; distinct-register or memory identity still copies
the source. The common SSE guard and RIP/RF/retirement remain even when pure
work disappears. A memory identity still preflights all sixteen bytes;
an unused word/half or identity must not hide a source-page fault.

The existing CPU profile/decoder, shared precise C-MMU pair transaction,
source generation and bounded engine owner remain the authorities.
Standard SIMD is required; relaxed SIMD/JS guest interpretation/fallback
are not introduced.

## Verification and actual rerun

[Comparison receipt](2026-10-05-vector-permutation-comparisons.json): 384
exact native/cold emissions; 49,152 unchanged pre-lowering native records;
49,152 direct and 49,152 C-dispatch CPU/RAM comparisons; 98,304 RF checks;
66,752 native fault comparisons; 5,376 control-priority models; 736 waits/
retries; 5,044 entry refusals; 140 aliases and 14 pair refusals pass.
All 256 immediate bytes across all 24 operand forms, two distinct whole-vector
patterns and direct/dispatch routes add 24,576 comparisons. These compile and
execute actual generated bodies against independent element-copy models,
not invented native records. Identity also preserves 120 native source-fault
observations; RIP-relative fixtures always point to valid code-page data, so
they are not mislabeled as address/fault fixtures. A first test assertion
incorrectly selected an aligned row and then a valid RIP-relative row as a
fault; only that test selection was corrected, not the compiler or oracle.

Static byte-coordinate shuffle/publication is asserted in every nonidentity
body. c=0xe4 has no shuffle; alias identity has no XMM payload read/store and
emits <=365 bytes. Nonidentity register modules are 399 bytes; memory forms
469–486 bytes, with no output image. These are per-cut budgets, not full-release
size claims. Standard required-SIMD refusal remains green.

All preceding 360 source pages/case populations/emitted modules are
byte-identical. Full native compiler/CLI checks and scoped compiler ASan/UBSan
pass. Scalar (108 exact/6,912 native), MXCSR (16 exact/4,096 native), borrowed
input/output growth and bounded engine lifetime regressions pass. The matched
no-image million-admission startup preserves 45 non-size/non-clock/timing
fields: 1,616,430 retirements / 1,000,000 admissions / 1,211 modules. A command
without the independent segment fixture first refused the hidden-cache
checkpoint; the required fixture path restores the unchanged comparison.
Native observations run in the independent WHPX build guest; Node executes
C-Wasm, not a guest interpreter or real-browser acceptance.

Compiler: 446,341 bytes (+882), SHA-256
`a4643f9d9a744e6b65d69aba53cc027e9fa99c2afa161a37f40216e1d40210f8`.
VM: unchanged 63,052 bytes, SHA-256
`a0bb464e8f4d3bd47e9dbc12fe84ac111cb9e9ad9a52d190be67a3f615cb814c`.
The final compiler is running on the same shipped bundle with independent
segment/root-image fixtures. Do not restart it or treat fixture acceptance as
actual PSHUFD/PID 1 execution. Native release and human UI remain unchanged.
Reproduce via the fresh-directory native/cold/Node/startup commands in the
[preceding checkpoint](2026-10-05-vector-shuffle.md).
Complete browser boot/PID 1, release-root mount, offline development commands,
authenticated storage/recovery and granted networking remain open. Cold shell
3s is unmet; engine/source reconstruction remains dominant. Strict CALL and
Windows RTC oracle reds are independent and still open.
