# Shared arithmetic and real native publication — 2026-10-10

## Required equivalence

An operand names an SSA generation, not merely a register number. For
`xchg rax,rdx; xchg eax,ebx; sub edx,eax; movsxd rdx,eax`, the result is
`EAX = entry.EBX - entry.EAX`, `RBX = zero_extend(entry.EDX)`,
`RDX = sign_extend(EAX)`. The old dense selection emitted
`mov eax,ebx; sub eax,eax; mov ebx,edx; movsxd rdx,eax` and was wrong.
The independent CPU test reproduces that red without Linux/function names.
An ALU left prefix cannot publish its accumulator while the right operand
still reads that accumulator's entry generation. Measurement and writing use
the same predicate, then the existing scratch schedule. If no safe schedule
exists, the ordinary source candidate remains a compile-time selection, not
an interpreter or runtime fallback. 65536 physical full/projected/relocation
state comparisons pass; an ordinary linked ELF fixture covers publication.

SSE add/sub/mul/div consumes raw IEEE words and MXCSR. Exact widening feeds
the existing shared two-word arithmetic residual. Guard/round/sticky fields
are rounded at the destination format, including subnormal scaling; there
is no intermediate binary64 rounding or host NaN substitution. DAZ preserves
zero sign. FTZ applies at the masked underflow boundary. Unmasked underflow
observes working precision before denormalization rounding. Packed lanes
join precomputation exceptions before any destination/late-flag publication.
These requirements follow the [Intel floating-point reference sheet](https://cdrdv2-public.intel.com/786447/floating-point-reference-sheet-for-intel-architecture.pdf).

The shared numeric SSA is construction evidence, not a saved instruction
stream. Its observed maximum work/span is403/101, NOT a global minimum or a
speedup claim. The backend currently spells its lane arithmetic with scalar
integer operations; further physical SIMD/work/span minimization remains.

## Receipts

- Native SSE:131072 raw-value/MXCSR comparisons, all RC/DAZ/FTZ combinations,
  special-value pairs and random raw words;4352 constructors/52224 malformed
  refusals. Actual C VM/ordinary Wasm:196608 complete-state comparisons,
  32 modules, scalar/packed/memory/unmasked exception profiles.
- PEXTRW:98304 coordinate constructors/393216 malformed refusals;32768
  physical full-state comparisons, every immediate, MMX/XMM and ignored REX.W.
  The native observer captures actual RAX; other GPR invariance is explicitly
  architectural, not independently sampled.
- FBLD/FBSTP:8192/16384 physical complete states and actual ten-byte store
  comparisons.18-digit packed fields share the integer/rounding core.
- INVD/WBINVD:14 constructor forms/112 malformed refusals and1792 C runtime
  privilege/identity models. The single serialized machine has no CPU data
  cache/writeback owner; resident pages and compiler proofs are not evicted.
  These are models, not independently observed CPL0 cache hardware.
- Fixed make final-PF_X-byte inventory:233428/233455,27 valid missing,
  zero missing fault/fetch/capacity cuts.25 x87 and2 SIMD coordinates remain.

The independent Alpine3.24.1 oracle verifies its official image signature
and all313 locked APK hashes/signatures. No SSH credential or external route
is used. GNU tar1.35 and BusyBox1.36.1 are the exact `data/sources.env` inputs;
BusyBox uses the fixed release config, not defconfig. Ordinary static
relocation-bearing linker outputs pass the current postlink/proof pair and
actual PAX extraction / mv execution. The complete native C gates and scoped
ASan/UBSan suite pass,232462ms. Source archive SHA256:
`74be09759d35c04fcfa370d64582bd4d37b5f3961c3198a1dd92d797b488bbb8`.
Local receipt: `temp/packed-shift-1009/isolated-publication-1010h.log`.

## Scope

The immutable native publication, real kernel and human UI are not changed.
A new boot root that replaces the two verified ELF payloads is an isolated
diagnostic candidate, NOT a signed package/release update. Publication must
rebuild package ownership/hash/signature records from final optimized bytes.
Actual-browser offline shell/toolchain/storage/network/cold3s remain separate
acceptance gates; neither this static inventory nor these CPU fixtures proves
Linux browser boot or universal ISA equivalence.
