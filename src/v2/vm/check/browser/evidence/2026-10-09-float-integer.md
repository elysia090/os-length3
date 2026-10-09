# Common floating-to-integer construction — 2026-10-09

The fixed published make's entire PF_X byte domain improves **460 ->445**:
233,010 lowerable of233,455 coordinates,15 conversions recovered. Remaining
SIMD169/x87154/far91/other31 retain the same total publication gate. The first
remaining selector query is still0f0200 at0xaf0c. This inventory is neither an
execution trace nor proof that all required Linux instructions are closed.
The native publication, signed delivery and human UI are unchanged.

## One conversion law, four destination projections

The independent C frontend checks CVTTPS2PI, CVTPS2PI, CVTTPD2PI, CVTTSS2SI,
CVTTSD2SI and CVTTPD2DQ. Both GPR widths are included: eight source/output
forms in total, not eight distinct mnemonics. Register/memory location,
element width, exact read extent, rounding and destination class are separate
construction facts. One Wasm emitter handles MMX64, GPR32, GPR64 and XMM128.
There is no new VM numeric callback, mnemonic interpreter or per-lane array.

MMX/SSE2 pairs use a two-lane binary64 projection. Binary32 promotion is
exact; scalar instructions replicate only the live low source, so garbage
upper XMM lanes cannot cause an exception. DAZ replaces exponent-zero inputs
with signed zero before conversion; FTZ is irrelevant to an integer result.
The graph rounds with the instruction's truncation or MXCSR rounding control
and derives invalid from the **rounded** value:

```text
r = specified_round(daz(source))
invalid = isnan(r) || r < -2^(w-1) || r >= 2^(w-1)
precision = !invalid && source != r
result = invalid ? signed_integer_indefinite(w) : integer(r)
```

The Wasm saturating conversion is only a safe total primitive beneath this
selection; x86 invalid results are indefinite, not saturation endpoints. The
GPR32 projection clears its parent upper32; the XMM pair projection clears the
upper64; MMX uses the existing full-tag/TOP publication owner. Numeric
conversion emits no DE, preserves unrelated flags and does not depend on the
host's rounding mode. See the [Intel conversion contract](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf)
and [standard SIMD encoding](https://github.com/WebAssembly/simd/blob/main/proposals/simd/BinarySIMD.md).

## Fault ordering and exact state

The SSE guard precedes operand access. MMX destinations additionally use the
existing pending-x87 #MF/FERR guard; GPR/XMM conversions do not. Exact4/8-byte
reads use the scalar port, while the128-bit source uses the already-general
pair reader with legacy16-byte alignment. A fault or residency wait publishes
no MXCSR, destination or MMX state. No padding extent is read or rebuilt.

New exception flags are separate from old sticky MXCSR flags. Independent
hardware exposed an important lane interaction: **unmasked invalid suppresses
new precision from another lane**. Masked invalid can coexist with precision;
existing sticky precision is never erased. The common emitter implements this
priority before publishing MXCSR or deciding the SIMD exception.

MMX tag/TOP transition occurs even on an unmasked SIMD exception, but the
destination payload/sign-exponent stays unchanged. Success writes the MMX
payload and sign-exponent through the same publisher. GPR/XMM conversions
never transition x87 state. #XM is routed through the existing C fault owner;
absent CR4.OSXMMEXCPT selects architectural #UD instead. These privileged
routes are C models, not claimed Windows measurements of x86 vector numbers.

## Independent observations and reproducible gates

The local Windows observer executes actual instructions and records full
FPU/XMM/MXCSR, RFLAGS and independently observed full tags. GPR invariance
outside the actual RAX destination is architectural, not a bare-metal
all-register certificate. The exception handler only recovers native oracle
execution at the appended RET; it is never a product guest fallback.

The complete population contains2,048 RC/DAZ/mask/register/memory profiles,
**131,072 physical rows**, including55,168 native invalid/precision exceptions.
32,768 rows set all masks. Signed32/64 limits, rounded boundaries, signed zero,
subnormals, infinities and both NaN classes are included, with irrelevant upper
scalar lanes deliberately populated. All rows match actual cold C compiler ->
ordinary Wasm -> C-MMU/table execution through64 distinct modules.

The retained earlier MMX-only population has73,728 matching rows. It is not
added to the complete population's unique count. Its initial mixed-lane
failure remains explained by the invalid-before-precision correction above.

8,840 native C constructions and141,440 malformed law/source-extent controls
pass, including unchanged output sentinels. Shared sources/Makefiles feed the
cold build. Positive ASan/UBSan includes the new constructor gate; scoped VM,
compiler and postlink checks pass without warnings, with464 postlink semantic
witnesses. The separately retained intermittent native CALL RAM-payload red
is not relabeled solved or retried into a universal pass.

**38,016 C boundary models** pass in direct and C table execution:
31,136 faults,2,400 waits,4,480 successes;552 serialized residency retries also
compare the complete final state. Deferred rows are promoted by a serialized
test owner, without changing guest PTEs or radix coordinates. This is not a
production authenticated delivery/recovery certificate.

```sh
make -C src/v2/x86 all
make -C src/v2/wasm-compiler all vector-float-integer-check
FLOAT-INTEGER-OBSERVER NEW-HARDWARE-DIRECTORY
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-HARDWARE-DIRECTORY --float-integer-complete
node data/oracle/check-vector-conversion-boundary.mjs VM.WASM COMPILER.WASM
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Compiler714,626 bytes, SHA256
`9de32b23c1d90e3b170f686673a89e3de9f7a173ba584c9b05efde94e007024d`.
Paired ABI4 VM99,070 bytes, SHA256
`61b9d2a49e38038105bf7cf0555346ff146be82a22bedf707918e539e5db11ea`.
The same-bundle bounded startup retains the86-cut/1,617,931-retirement witness.
No fresh signed root, browser PID1/offline shell, cold3s, RSS, native size or
speed claim is made by these conversion gates. Continue whole floating,
selector and far-control families to ZERO and full browser acceptance.
