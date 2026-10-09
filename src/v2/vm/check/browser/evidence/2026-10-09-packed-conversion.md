# Lane-native integer operations and exact CVTPI2PS — 2026-10-09

The same published make's every-PF_X-byte inventory improves **514 ->460**,
232,995 lowerable of233,455. **54 CVTPI2PS coordinates recovered**; remaining
SIMD184/x87154/far91/other31 still use the unchanged total publication gate.
The preceding packed integer additions broaden general ISA closure but do not
appear in this fixed make's missing population; they are not counted as a
make speed/coverage gain. Native release/human UI are unchanged.

## Shared lane law, no scalar reconstruction

The existing MMX64/XMM128 binary law gains high signed/unsigned multiplication,
signed multiply-add, unsigned even-dword multiplication, rounded/scaled word
multiplication, signed/unsigned saturation packs and byte absolute-difference
sums. Both widths use bounded v128 temporaries and the same publication owner.
No per-lane array, CPU snapshot, guest opcode callback or scalar runtime loop
is introduced. MMX still applies its existing #UD/#NM/#MF guard and saved-tag
projection. Register aliases retain exact substitutions, including SAD(a,a)=0.

PMADDWD maps to signed vector dot-product, including its wrapping signed
overflow corner. High products widen before shifting. PMULUDQ selects only
the even dwords before exact unsigned widening multiplication. PMULHRSW uses
signed widening, add0x4000, shift15 and **truncate**, not Wasm's saturating q15
operator: (-32768)*(-32768) must yield0x8000. Packs use saturation followed by
the width's exact region selection; duplicating a64-bit input and blindly
extracting the low half would incorrectly drop the second source.

These emitters use the [standard SIMD encodings](https://github.com/WebAssembly/simd/blob/main/proposals/simd/BinarySIMD.md)
and Intel's [packed-integer contract](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf).
The constructor checks all42 families:14,448 common/native MMX/XMM forms and
115,584 malformed-output sentinel controls. Independent physical FPU/RFLAGS/
tag/RAM comparisons cover7,776 MMX +12,960 XMM rows through243+405 modules.
Other GPR invariance is architectural, not a bare-metal all-register claim.

## Exact integer-to-float lane projection

CVTPI2PS now has a checked common frontend law and ordinary Wasm construction.
It converts the two signed32-bit source lanes, preserves the destination's
upper64 bits and updates MXCSR's precision status. It does not execute a
source-ISA interpreter or scalarize the lanes.

Signed int32 is exactly representable in binary64. The generated vector graph
therefore performs:

```text
exact64 = exact widening of the two signed int32 lanes
rn32    = nearest-even demotion to binary32
back64  = exact promotion of rn32
PE      = any(back64 != exact64)
```

Comparisons back64>exact64 and back64<exact64 determine whether directed
rounding needs the adjacent IEEE encoding. A lane sign mask chooses encoding
direction; toward-zero moves one magnitude encoding toward zero only when
nearest moved away from zero. There is no integer saturation, host rounding
mode, approximation or double rounding. The graph corrects the nearest result
with vector integer operations, then publishes only the low64 destination.

Native testing found structured-Wasm stack/local-bound mistakes during initial
construction; the final typed vector/scalar frame and branch results are
validated by actual engine compilation and execution, not merely C emission.
Opcode comparison directions are fixed according to the standard SIMD table,
not a relabeled expected result.

## Precise exception and MMX boundary

SSE #UD/#NM and the existing pending-x87 guard precede conversion/operand
access. MXCSR PE latches before an unmasked SIMD precision fault. The
destination remains unchanged and the source instruction is not retired.
The machine owner already accepts #XM19; CR4.OSXMMEXCPT=0 selects #UD instead.
The latter routing is an architectural lowering, not independently measured
by the Windows user-process oracle.

Register source causes the x87->MMX tag/TOP transition **before even an
unmasked precision fault**; memory source does not transition. The precision
predicate stays in a separate scalar slot while the existing tag projector
uses its scratch slots. This ordering follows Intel's
[CVTPI2PS description](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf)
and actual independent fault states. No new VM numeric helper, duplicated
MMX publication path or runtime fallback is added.

## Independent populations and product gates

All four RC modes, five XMM coordinates (including extended registers), three
MMX source coordinates/memory, ignored/address prefixes, exact/inexact edges,
int32 limits and randomized pairs give240 profiles/23,040 complete physical
FP/MXCSR/tag/RFLAGS rows. Final C compiler -> ordinary Wasm -> C-MMU/table
matches every row. A second **23,040** row population unmasks precision;19,673
actual Windows precision exceptions occur. A vectored exception handler skips
the native test instruction only for oracle recovery, never in product guest
execution. Windows exception codes are not relabeled as measured x86 vector
numbers. The C product's architectural #XM/status/state comparison matches the
independent outcomes, including the pre-fault MMX transition and untouched XMM.

The checked CVTPI2PS construction passes720 source/register/address forms and
8,640 malformed laws. Scoped compiler/postlink and positive ASan/UBSan pass
without warnings;464 general postlink semantic witnesses remain green. The
older unrestricted intermittent CALL RAM-payload equivalence red remains
[separately retained](2026-10-05-call-fault-windows.md), not declared solved.

Final compiler709,054 bytes, SHA256
`20ea0efdb6b58103c62e4101343b4affd7a1afb967675accd9b49ca488a660c0`.
Paired ABI4 VM remains99,070 bytes, SHA256
`61b9d2a49e38038105bf7cf0555346ff146be82a22bedf707918e539e5db11ea`.
Same-bundle short startup retains86-cut witness/1,617,931 source retirements/
quota; it is not actual PID1/offline shell/cold-ready/RSS evidence. No signed
root or native artifact is replaced and no browser/kernel acceptance is claimed.

```sh
make -C src/v2/x86 all
make -C src/v2/wasm-compiler all packed-binary-check vector-integer-float-check
PACKED-OBSERVER NEW-MMX --extended
PACKED-OBSERVER NEW-XMM --wide-extended
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-MMX --mmx-extended
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-XMM --packed-extended
CONVERSION-OBSERVER NEW-ROUNDED
CONVERSION-OBSERVER NEW-PRECISION-FAULTS --faults
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-ROUNDED --integer-float
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-PRECISION-FAULTS --integer-float-fault
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Continue the remaining conversions/SIMD, floating state and far-control
families to ZERO and the complete actual-browser objective.
