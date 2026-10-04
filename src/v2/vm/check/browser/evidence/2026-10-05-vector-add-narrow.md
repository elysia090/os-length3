# Packed addition without a lane loop — 2026-10-05

The independent initial-unpack startup has completed and actually passes
PUNPCKLDQ, the second unpack and PUNPCKLQDQ. Its next real gate is
`66 0f fe c4` (`paddd %xmm4,%xmm0`), 0xffffffff81204e2a:
[receipt](2026-10-05-node-startup-paddd-red.json), 164,915,078 retirements /
89,541,416 admissions. All 14,622,864 decompressed bytes agree. This run
uses the initial correct unpack compiler, before the additional self-alias
substitution; it is not relabelled as a final-compiler run. Raw local receipt
SHA-256: `725e0b515865f4ddcee187ac44bdf7292eb88e66284cb193b19b1050a2bbce6f`.
PID 1, release-root mount and shell remain unverified.

## General substitution, before implementation

[Red first](2026-10-05-vector-add-narrow-red.log): native x86 captures 32,768
CPU/RAM observations / 14,768 fault frames; the common compiler rejects
new form 232 with -102. PADDD/PADDB/PADDW add 24 forms to the unchanged 232
transfer/logic/unpack/PADDQ forms. Each has separate registers, self-alias
and six memory address topologies, including high XMM registers.

Intel [SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B PADDB/PADDW/PADDD/PADDQ and type-4 exceptions, specifies wraparound
addition independently in each integer element, no flag or numeric exception,
and the unchanged legacy SSE operand boundary.

Let `w` be 8, 16 or 32; let `H` contain bit `w-1` in every lane, `L=~H`,
and `I` contain bit zero in every lane. For each of the two old word pairs:

```text
add_w(a,b) = ((a & L) + (b & L)) ^ ((a ^ b) & H)
add_w(a,a) = (a << 1) & ~I
```

Proof: the lower fields are each less than 2^(w-1), so their sum is at most
2^w-2 and cannot carry outside its lane. It may set that lane's bit w-1.
Adding the old top bits modulo 2^w toggles this bit by their parity, exactly
the second XOR term. Every lane is disjoint; therefore the word formula is
valid for every a,b, including overflow, rather than a sample specialization.
For self-addition, doubling shifts the old top bit into the next lane's bit
zero; clearing all such bits removes exactly those unwanted carries.

The common C compiler emits two independent fixed word networks and publishes
both results only after the shared SSE guard and complete aligned operand
preflight. No runtime lane loop, scalar lane array, host SIMD/FP state or
mnemonic-specific VM callback is added. Register self-alias does not reload
the destination: its result uses the captured source words. PADDQ retains
its existing two-i64-add emission unchanged.

The distinct-word network has six i64 ALU operations per word, graph depth
three when operands/constants are available; self-add has two operations
per word, depth two. These counts exclude architectural loads/stores,
precise admission and constants. They are not a global minimum proof or a
native speed claim: native x86 already uses one packed-add instruction.

## Verification and actual next run

[Comparisons](2026-10-05-vector-add-narrow-comparisons.json): 256 exact
native/cold emissions; 32,768 unchanged pre-lowering native observations;
32,768 direct and 32,768 C-dispatch CPU/RAM comparisons; 65,536 RF checks;
59,072 native fault comparisons; 3,584 control-priority models; 656 wait
and retry cases; 3,460 entry refusals; 124 aliases; 14 pair refusals pass.
There are also 768 whole-word carry corner models and all 65,536 byte input
pairs executed through the actual emitted register body, with opposite
high-word carry situations. These are explicit models, not native records.
The reference is element-by-element, not the compiler's word formula.
All preceding 29,696 records, 232 source pages and 232 emissions are
byte-identical. Full unrelated CPU/MXCSR/x87 and RAM/code preservation stays.

Full native compiler checks/CLI and scoped compiler ASan/UBSan pass. Scalar
and MXCSR native/cold regressions and borrowed-input/output-growth checks
pass. The matched no-image one-million-admission startup retains every
non-size, non-UTC/clock/timing observation, including 1,616,430 retirements,
620,243 emitted bytes, 7,262,208 borrowed bytes, zero copied bytes and the
same C-source/engine/resident observations.

The final compiler is 444,118 bytes (+764 from final unpack), SHA-256
`95b4630185a52e8b67c9f4b5037cfd72f551dc12adefa415b9a7668c7bda65a4`.
The unchanged 63,052-byte VM and this compiler are now running independently
on the same native bundle, with the independent segment and root-image
fixtures. Do not overwrite/restart that live run or treat fixture pass as
actual PADDD/PID 1 execution. Native delivery and human UI are unchanged.

In the completed unpack startup, engine reconstruction still dominates:
17,597,568 constructions / 17,596,821 evictions, 745 entries / 261,966 bytes.
Phase ms: cold 171,283.7; engine 439,788.6; execution 98,021.7;
admission 22,531.3; supply 183.5; elapsed 875,821.0. Copied code bytes are
zero; borrowed source bytes total 83,537,559,552 and allocated Memory is
20,512,768 bytes. Calibration/work variation prevents a speedup claim.
Three-second cold shell, engine/region closure, browser acceptance, PID 1,
offline development commands, authenticated storage/recovery and granted
network remain open. Strict CALL and Windows RTC oracle reds remain open.
