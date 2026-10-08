# Exact integer-memory arithmetic through the common SSA — 2026-10-08

The published make's first FISUB now lowers through the shared x86 math owner,
ordinary Wasm and existing C machine boundary. The SAME 233,455 final PF_X byte
coordinates now have 227,051 lowerable / **6,404 missing**, down from 6,545 at
`6193c03`: **141 coordinates recovered**. The first miss is `d818` / memory
FCOMP at `0xa0df`. Full-directory construction STILL refuses -102 before
creating a directory/root. This is not a complete Linux image or frequency
measurement. Native bundle, VM and human UI are unchanged.

## Reverse requirements and a bounded numeric residual

Integer16/32 conversion reuses the exact signed coercion already shared by
FILD. Extended A remains `(sign, exponent, explicit64 significand, occupancy)`;
there is no f64 conversion. The common expression builder has one internal
owner and sequenced construction, not independent backend floating math.

For finite accepted inputs, replace encoded exponent zero by effective one
and order magnitudes lexicographically. Select operation signs before the
add/sub law; NaN/unsupported/empty behavior is classified separately.
At the larger exponent E, align the smaller significand as a two-word residual:

```text
U = significand << 64
aligned = floor(U / 2^distance), with discarded_nonzero folded into bit 0
```

Distance zero/64/128 and greater are total guarded cases over lane shifts;
there is no undefined C shift. Same signs add the larger high word and aligned
pair, retaining carry and right-shift residual. Different signs subtract the
aligned pair with the low-word borrow, then left-normalize the pair. The
exponent carries an extra +128 bias, so no signed implementation-dependent
shift/comparison is needed. Zero is a separately selected sign/RC outcome.
At exponent gap <=1 no source bits are lost before deep cancellation; for
canonical nonzero gap >=2, at most one left-normalization bit is needed.
The discarded-nonzero residual preserves the final rounding observations.

The defined PC encodings choose 24/53/64 significant bits. The local reserved
PC=01 observations use full precision but are not a general ISA certificate.
Nearest-even distinguishes greater-than-half, exact tie and retained parity;
directed rounding depends on sign and any discarded bit. C1 is the selected
magnitude increment. Gradual underflow uses the same two-word shift/round law.
Tiny-after-rounding plus inexact is the masked underflow condition; an unmasked
tiny register result can require underflow even when it is exact. The selected
unmasked result is rounded at the normalized scale and exponent-adjusted by
24576, not replaced by masked zero/infinity. OE/UE/PE publication therefore
cannot use comparison's IE/DE suppression rule.

Unsupported/empty selects indefinite; SNaN raises IE and quiets the input when
masked, while QNaN retains its payload. Reverse subtraction changes finite/
infinity signs, not the original NaN sign. DE is preserved for denormal and
pseudo-denormal A, but lower-priority numeric exceptions are suppressed when
IE/DE is unmasked. The final pure outputs are significand, sign/exponent and
outcome: newly raised bits, C1, payload suppression and physical tag class.
No architectural memory/event effects are implemented by this numeric DAG.

`pl_builder` and projected compaction share nodes, remove unused values and
schedule dependency waves. Maximum measured **313 abstract nodes / span 83**
is NOT an x86 instruction count, proved minimum, or execution-speed claim.
This all-control-word implementation is a correctness baseline, not a claim
that its work/span is finished. The graph is temporary construction evidence,
never another saved runtime format or a VM opcode stream.

## Single state/memory/event publication

The checked common descriptor owns FIADD/FISUB/FISUBR widths and decoded FOP.
The backend uses the same validated pure-plan emitter, whose finite operator
set did not grow for this arithmetic. It does not call an opaque math library.
EM/TS #NM and previous unmasked #MF/legacy C FERR wait precede readonly operand
access. Complete C-MMU load precedes numeric or FPU publication.

Only physical TOP's payload/tag is updated; neither register arrays nor TOP
are rotated. IE/DE suppression skips that write. OE/UE/PE publish the selected
rounded/scaled result, then sticky SW/C1 and deferred ES/B. New unmasked
conditions record the actual FOP/FDP; FIP names the admitted source. CW,
unrelated FPU/XMM, GPRs and RFLAGS are unchanged except existing retirement/RF
ownership. Deferred exception/interrupt delivery remains the SAME typed C
boundary; no new VM operation, ABI or math import was introduced.

The construction scratch is bounded at 128 KiB; actual arena used is at most
74,076 bytes in the six numeric plans, with a second compaction probe inside
that bound. Cold C stack reservation is now explicitly 256 KiB to contain
scratch plus parent frames. The existing `compiler_arena_min` exports the
new end, so caller input/output and VM metadata remain disjoint. This is a
larger fixed compilation reservation, NOT a quota relaxation, memory/RSS
improvement or execution allocation. Private x86 headers are now dependencies
of the incremental cold build too.

## Independent gates and the observation limitation

Fresh low-address physical Windows captures provide **36,864 complete-state
C-Wasm/C-MMU/table comparisons**, 576 forms through **six modules**, including
4,460 pending unmasked errors / 2,096 changed payloads while pending. Actual
RFLAGS/FPU are captured; GPR invariance is architectural. 2,880 canonical
masked/non-reserved-PC rows also match official SoftFloat. Common numeric SSA
matches all 36,864 hardware numeric/outcome rows. Another **240,000 canonical
finite samples** span signs, integer widths, close/far exponent gaps, precision
and all RC modes against official SoftFloat; this numeric reference does not
certify stack, memory or unmasked publication. The library remains build-only.

A full-state gate initially failed at form 539 / row 39, in FIP/FDP alone:
the expected native pointers were truncated to `0x8b800000/0x8b801000` rather
than the allocated full addresses. Other payload/status fields agreed.
Windows' [published XSAVE_FORMAT](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/Diagnostics/Debug/struct.XSAVE_FORMAT.html)
has 32-bit ErrorOffset/DataOffset fields; a host context save/restore is a
plausible cause, not a proved event trace. The oracle now allocates its real
code/data BELOW 4 GiB, with RW/RX separation, before capture. New records are
generated independently; no failing row/pointer is patched or ignored.
Both representable coordinates bind to the guest map exactly. This removes
host-address truncation from this oracle domain; it does NOT certify high64
native x87 pointer preservation across Windows context switches.

**48 native/cold forms** have byte-identical ordinary Wasm. 576 malformed
common/native laws and unchanged capacity failures pass. The unified integer
fault driver adds **1,080 #NM/#MF/page-fault models / 72 success controls**,
including prefixes, FS/GS, readonly/absent and cross-page operands; faults
preserve CPU/RAM. FILD's 12,288 full-state comparisons and 540 fault models,
the prior 16,384 compare observations and 288/72/1 deferred-boundary cases
remain green. These C models are not a hardware fault-priority/legacy-pin
certificate. Full current compiler/postlink and positive arithmetic ASan/UBSan
are warning-free. Old FILD-only fault code is renamed/generalized, not retained
as a parallel model implementation.

Same-bundle short Node diagnostic retains the independent 86-instruction
witness and 1,617,931 retirements / 1,000,000 admissions, then unchanged quota.
It is raw startup regression, NOT an authenticated Linux root, browser boot,
shell, speed/RSS or cold-ready test. Cold compiler is **562,188 bytes**, SHA-256
`652157c0323cf3be81ba0f87f04ffb654a5782d8b088e0730e9adde165c684a6`:
57,460 bytes larger than `6193c03`. VM remains 95,012 bytes,
`92d917f30526f46b00554202de16fcfc0f5eae5f0af537ebc554bfc74b01be5c`.
No artifact compression or execution-speed improvement is inferred.

## Reproduction and next actual obligation

```text
make -C src/v2/wasm-compiler x87-arithmetic-check
make -C src/v2/wasm-compiler check
bash src/v2/wasm-compiler/check/sanitizers.sh
observe-arithmetic NEW-HARDWARE-DIRECTORY
arithmetic-ssa NEW-HARDWARE-DIRECTORY --ssa
finite-reference
node data/oracle/check-x87-integer-memory.mjs VM.wasm COLD.wasm NEW-HARDWARE-DIRECTORY --arithmetic
node data/oracle/check-x87-integer-fault.mjs VM.wasm COLD.wasm --arithmetic
node data/oracle/check-x87-code.mjs COLD.wasm NATIVE-ARITHMETIC-CODE 48
node data/oracle/check-x87-boundary.mjs VM.wasm COLD.wasm
```

Build the observer with Windows GCC and support/machine include paths. Build
`check-x87-arithmetic.c` and `check-x87-finite.c` against common x86/support and
pinned official SoftFloat, with matching FAST_INT64/LITTLEENDIAN interfaces.
Original upstream lives in data; records/objects are ignored Windows temp.
The next first gap is memory FCOMP: derive IEEE32/64 conversion AND original
operand denormal/NaN classification, then reuse the relation and physical
state owners with exact memory-fault/pop/deferred semantics. No fresh browser
run, signed production root or Linux acceptance was obtained in this checkpoint.
