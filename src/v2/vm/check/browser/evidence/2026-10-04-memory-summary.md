# Common memory scan/count cut — 2026-10-04

The same shipped native bundle passes the previous memory BSR gate at
`0xffffffff811223a7` in the real ordinary-memory browser Worker. No native
release or human UI bytes were changed. The next compiler -102 is
`49 0f c7 4d 20`, CMPXCHG16B [R13+0x20], at `0xffffffff8111de16`.
PID 1/shell and the full browser goal are still red. The diagnostic JSON's
`status: pass` is not Linux boot: its separate `linuxBoot: not-achieved`
remains authoritative.

## One semantic value, after one precise read

For an n-bit source, x is its zero extension to 64 bits. Nonzero BSR is
`63 - clz64(x)`; nonzero BSF is `ctz64(x)`; POPCNT is `popcnt64(x)`.
The existing register summary and the new memory summary share exactly
`cut_summary_value`, including narrow-parent publication and flags. The
memory form first borrows its effective address and performs one typed
`machine.access` read through the actual C-MMU. No source opcode, scan loop,
per-byte callback or second guest-memory owner is introduced.

The read's fault/residency/stale/refusal returns before any GPR, flags, RIP,
RF or retirement publication. In particular, known zero cannot elide that
read. Pure prefixes remain a separately retired cut. SS, SIB, RIP-relative,
extended/aliased GPR and 32-bit address forms use the existing address owner.
FS/GS and unsupported debug/alignment contexts are not silently accepted.

Legacy scans define ZF from source zero, while their other arithmetic flags
and zero-source destination are undefined. Keep the incoming undefined flags
and choose the incoming whole destination parent for zero, including its
32-bit upper half. This is an explicit representative, not a claimed physical
CPU output. POPCNT clears the arithmetic flags except source-zero ZF.
The normative instruction descriptions are Intel SDM Volume 2A, BSF/BSR,
and Volume 2B, POPCNT:
[Volume 2A](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf),
[Volume 2B](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf).

## Red / green evidence

- Before lowering, all 180 entrances were compiler -102: BSF/BSR/POPCNT and
  prefixed legacy twins, three widths, both address widths and six address
  shapes. The unchanged test now passes, including the actual RBP+24 gate.
- 135 ordinary ELF fixtures pass link -> independent post-link -> proof
  verification -> native C Wasm emission. 69,120 complete CPU/RAM comparisons
  pass through the actual C provider/MMU, alongside 61,440 protection-fault
  comparisons, 130,560 RF checks, 130,560 separate C dispatcher comparisons
  and 270 exact residency wait/retry pairs. A callback test double separately
  passes 69,120 comparisons; it is not the product memory backend.
- The immutable CPU profile has no BMI1/LZCNT. Native host supersets execute
  F3 as TZCNT/LZCNT, so 54 fixture modules use a clearly labeled native
  legacy-scan twin. The product and original source-page bytes are untouched.
  The oracle-only leading NOP preserves fallthrough/EA, but an actual fault
  begins one byte later. Records retain that raw native fault RIP; metadata
  exposes `nativeFaultOffset: 1`, and the checker verifies it before mapping
  it to the original instruction. This is not a literal F3 hardware witness.
- 1,108 byte-identical native/cold emissions pass, including 135 new memory
  modules and the shipped bundle prefixes. The 23 real cold source-admission
  cases, previous 75 register-summary modules and 132 carry-memory modules
  also pass. The latter has 67,584 CPU/RAM and 59,392 protection comparisons.
- Fresh native/cold branch, CALL, extension, LEAVE, POP, division, implicit
  product and memory-division regressions pass. Descriptor transfers retain
  96 modules / 16,128 models / 108 native comparisons; system selectors retain
  144 modules / 153,360 models / 3,024 defined native comparisons with the
  pre-existing 48 explicitly classified software-oracle differences.
- Full `make -C src/v2 -k -j2 check` passes. The selected lowering/library
  ASan/UBSan code-cut check and native memory scan/POPCNT harness pass; their
  linked decoder/support/proof archives are ordinary builds, not whole-TCB
  sanitizer coverage. The unchanged VM core sanitizer result is inherited
  from the immediately preceding debug-register checkpoint.

Two test infrastructure defects were exposed rather than hidden. Poisoned
unrelated state had enabled DR7; generic oracle inputs now explicitly seed
disabled DR7=0x400 before snapshots while leaving all other poison intact.
The real refusal guard was not weakened. That revealed an obsolete indirect
JMP RF-refusal expectation: 6,144 new checks now require successful RF clear
or pending-fault RF preservation; TF still refuses. Also, the new fixture
script's nested Make rebuilt a verifier during another fixture's execution,
causing a real permission error. The parent Make graph now supplies completed
tools via `--built`; the full parallel check was rerun after this correction.

Reproduce native receipts with
`bash data/oracle/prepare-memory-summary-cuts.sh NEW-DIRECTORY`, build the cold
compiler with `data/oracle/wasm-tools.ps1 -Compiler -Output NEW/compiler.wasm`,
then use `check-wasm-provider.mjs VM.WASM NEW-DIRECTORY --dispatch` and
`check-cold-compiler.mjs`. `memory-summary-fixture-check` is part of the normal
product check, not an optional green-only fixture.

## Actual browser, not a speed or completion claim

The complete independent inflate witness remains 14,622,864 bytes / 3,571
pages, SHA-256 `6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
136,921,258 retired / 69,222,947 admissions reach the next gate, with zero
manual branch entries. Six #PF and ten #GP events were delivered to Linux's
handlers; thirteen virtual-clock events occurred. No boot percentage follows
from those counts.

49 ranges fetched 3,154,432 bytes for 3,046,912 requested bytes; transport
cache high-water is 65,536 bytes. 4,403 resident pages / 4,390 supplied pages
use 18,874,368 VM bytes; cold compiler memory is 1,048,576 bytes. The C source
cache is still 64 rows / 6,752 metadata bytes / zero copied source payload.
67,975,938 source hits and 1,247,010 misses were recorded. The engine retained
64 modules / 21,366 bytes but performed 1,247,009 compilations and zero reuse
hits. This remains a major fixed cost, not evidence of adequate reuse.

434,744,482 emitted bytes and 5,108,031,488 copied code bytes are cumulative
work, not RSS or the release's stored size. This concurrent diagnostic took
18,583.9 ms cold setup, 109,255.6 ms engine, 36,480.3 ms execution,
22,701.7 ms admission and 190.6 ms supply. It is not a controlled benchmark,
a speedup claim or a cold-shell measurement; the three-second shell goal is
unmet.

Provider remains 40,351 bytes, SHA-256
`4a6fca3ebeb0b0399a8f87dbc995919b058600daeb663fa3ea9e7e8c5486d622`.
Compiler is 428,146 bytes, SHA-256
`2811bdad47a3cc1ab2bca5a4b0199b109b72a5173978285b68a8c9df3daf74f4`.
The full actual DOM receipt is [browser JSON](2026-10-04-memory-summary-browser.json).
Generated browser objects have local diagnostic digests, not a newly signed
production admission claim.

Next: close common CMPXCHG8B/16B through a precise bounded C reservation,
shared compare/publish SSA, width/alignment/fault-ordering tests and exact
single-owner atomicity. Do not scalarize the 16-byte operation into independently
visible transactions. Debug exception delivery and active address breakpoints
remain explicit limitations from the preceding checkpoint.
