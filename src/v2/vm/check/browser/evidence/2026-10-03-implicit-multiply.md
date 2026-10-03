# Implicit full products — 2026-10-03

The same shipped native bundle and fixed CPU profile remain authoritative.
Linux/PID 1/offline shell, development tools, authenticated workspace recovery
and granted networking remain the active product goal. Cold shell 3 seconds
is unmet. This change neither rebakes the native release nor edits human UI.

## Red and shared product normal form

The previous actual browser refused `48 f7 e2` (MUL RDX) at
`0xffffffff810ab884`. The general native observer first ran all 32 implicit
register forms without lowering (16,384 observations), then reproduced
`implicit multiply form 0 red: compiler=-102`. The old shared product shape
only admitted signed truncated two/three-operand IMUL.

The [Intel MUL definition](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf)
specifies AX for byte products and DX:AX / EDX:EAX / RDX:RAX for wider
products. CF/OF report a nonzero unsigned high half; the other four arithmetic
flags are undefined. One-operand signed IMUL instead tests whether the full
product is the sign extension of its low half. Undefined flags keep the
existing incoming representative, not a fabricated hardware equality.

Let `B=2^32`, `a=a0+B*a1`, `b=b0+B*b1`, with all four limbs below B:

```text
lo   = a*b mod 2^64
t    = (a0*b0 >> 32) + a1*b0
hi_u = a1*b1 + (t >> 32) + ((a0*b1 + (t mod B)) >> 32)
hi_s = hi_u - [a<0]*b - [b<0]*a mod 2^64
```

The two carry-bearing intermediate sums fit u64: their upper bounds are
`B^2-B-1` and `B^2-B`, respectively. Expanding `a*b` and collecting powers
of B derives `hi_u`; substituting the signed two's-complement operands derives
`hi_s`. The previous truncated signed product and both new full products use
this same high-limb emitter. Narrow full products fit the existing i64 value.
No host multiplication callback, i128 helper, floating point, opcode
interpreter or additional materialized CPU frame is introduced.

CF/OF compare high with zero (unsigned) or the width-bit sign mask of low
(signed). Inputs are captured before any aliased RAX/RDX/AH write. Byte
products replace AX, word writes preserve upper parents, dword writes zero
them and qword writes replace them. Sequential composition reads the current
SSA publication, including the first product's high half. Dead intermediate
flags remain dead. This is an exact lowering, not a global minimum work/span
proof for arbitrary multiplication sequences.

Memory source is one precise C-MMU READ before the same product SSA. The
first visible operand being memory does not make this a STORE/RMW. Effective
address is retained before implicit register publication; #PF, wait, entry
refusal and retry leave CPU/flags/RIP/retirement untouched. The existing
epilogue clears RF only after successful retirement. Invalid LOCK and
unsupported FS-base forms remain explicit grammar refusals.

## Verification

[The native receipt](2026-10-03-implicit-multiply-native.json) records:

- 32 isolated register forms plus six composed products/product-SETcc modules:
  19,456 complete native CPU observations, separately through direct Wasm and
  the actual C VM dispatcher; another 19,456 successful RF checks. A generic
  whole-linear-memory observer also checks all 38 modules.
- 1,568 additional exact unbounded-integer algebra cases over all four widths
  and both signs; these are test-only oracles, not native observations or a
  runtime path. 190 TF/wrong-RIP/alignment/bounds/stale refusals pass.
- 46 independently built, postlinked and proof-verified memory fixtures:
  23,552 success / 22,528 actual protection-fault frames through C VM/MMU,
  46,080 RF checks and 46,080 separate C-dispatch comparisons. Address widths,
  register/base/index aliases, SIB, SS, RIP and cross-page access are covered.
- Full product `make check`, selected compiler/lowering/native observer
  ASan/UBSan and 1,008 cold/native byte-identical emissions pass without
  warnings. Linked decoder/support/proof archives are normal builds, not
  whole-TCB sanitizer coverage. The x86 oracle is the reference QEMU TCG build
  VM, not physical hardware or product exception-delivery evidence.

Reproduce with `data/oracle/prepare-implicit-multiply-cuts.sh NEW-DIRECTORY`,
then `check-implicit-multiply.mjs VM.WASM COMPILER.WASM NEW-DIRECTORY/register`,
`check-wasm-cuts.mjs NEW-DIRECTORY/register` and
`check-wasm-provider.mjs VM.WASM NEW-DIRECTORY/memory --dispatch`.
The first script refuses existing outputs. `implicit-multiply-check DIR
--observe` captures native rows without requiring lowering, so the native
oracle and compiler acceptance cannot silently become the same test.

Compiler: 425,412 bytes, SHA-256
`51fa36cecae5ebdc94acd17b885b8f217aeee2e3db074b5f8097fe7cdd72fa7f`.
VM: unchanged 36,584 bytes, SHA-256
`105c3be7eb19171c65b39f15922a5f9de6a1bc1849601a5521e701097fb08891`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and next gate

[The actual browser receipt](2026-10-03-implicit-multiply-browser.json)
passes MUL RDX and reaches 136,073,617 retired / 68,669,194 admissions.
The next refusal is `f7 7c 24 04`, IDIV dword [RSP+4], at
`0xffffffff81008e75`. RAX=1, RDX=0, RSP=0xffffffff81a03e20. The next task
is the general memory DIV/IDIV connection to the existing precise divider;
do not add a kernel-coordinate result or scalar interpreter.

Complete independent decompression remains 14,622,864 bytes / 3,571 pages,
SHA-256 `6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Eight #PF / seven #GP events enter Linux's own handlers. There are zero manual
branch entries. Nineteen diagnostic clock events do not establish the Linux
calibration frequency. Linux/PID 1/shell and production admission remain unmet.

Delivery remains 49 HTTP ranges / 3,154,432 fetched / 3,046,912 requested bytes,
65,536 cache high-water. Progress increases supplies/residency to 4,275 / 4,288
pages and VM memory to 18,350,080 bytes; cold memory remains 1,048,576 bytes.
Source identity keeps 64 rows / 6,752 metadata bytes / zero source payload
copies, with 67,496,242 hits and 1,172,953 misses. Engine residency is bounded
at 64 modules / 20,997 bytes, but cumulative engine compilations are 1,172,952
with zero reported engine-reuse hits. Cumulative emitted 387,687,546 and
copied 4,804,677,632 bytes are work, not RSS/artifact/delivery size.
Cold/engine/execution/admission/supply observations are 16,551.9 / 94,898.4 /
35,080.2 / 22,516.0 / 241.2 ms. These are uncontrolled progress receipts, not
a speedup or cold-ready claim. Semantic closure is still the immediate boot
gate; exact bounded topology/instance reuse remains a separate large cost.
