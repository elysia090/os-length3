# Integer/IEEE SSA, comparison frontier and one exception publisher — 2026-10-09

The fixed make's complete PF_X byte inventory improves **445 ->397**:
233,058 lowerable of233,455.29 CVTSI2SS/SD coordinates and19 COMISS/UCOMISS/
COMISD/UCOMISD coordinates are recovered. Remaining SIMD121/x87154/far91/
other31 preserve the unchanged total publication gate; first0f0200 at0xaf0c
is a selector query. Native publication, signed delivery and human UI are
unchanged. This is progress toward total closure, not a Linux boot certificate.

## Exact signed integer -> IEEE, before either backend

The common integer-to-float law now includes both signed32/64 input widths and
binary32/64 scalar output widths, memory and every GPR/XMM coordinate. It
retains CVTPI2PS in the same checked owner. No VM numeric helper, host rounding
mode or source-ISA evaluator is introduced.

The independent x86 SSA normalizes the signed integer once. With magnitude m,
leading count l, fraction width f and format bias b:

```text
s = m << l                    e = 63-l
d = 63-f                      r = s & (2^d-1)
q = s & ~(2^d-1)             PE = (r != 0)

RN increment = r > 2^(d-1) || (r == 2^(d-1) && ((s >> d) & 1))
RD increment = negative && PE
RU increment = !negative && PE
RZ increment = 0

t = q + increment*2^d       carry = t < q
s' = carry ? 2^63 : t        e' = e + carry
bits = sign | ((e'+b) << f) | ((s' >> d) & (2^f-1))
zero input -> zero bits
```

Unsigned magnitude arithmetic includes INT64_MIN without signed overflow.
The zero/shift representatives are total. There is exactly one final rounding;
conversion through binary64 and back is not used, avoiding double rounding
and the INT64_MAX rounded-to2^63 saturation trap. Signed32 -> binary64 is
always exact, so its precision output and rounding subgraph disappear.

The normalization owner exposes sign and leading count directly. Packing an
extended80 intermediate only to unpack its fields was removed from the live
graph: maximum retained nodes/span **50/26 ->44/24**. These are current graph
upper bounds, not independently proven global minima. Scalar output stores
only4/8 bytes and preserves the remaining XMM region; GPR/memory sources do
not transition x87 state. DAZ/FTZ do not change integer inputs.

The [Intel conversion contract](https://cdrdv2-public.intel.com/774492/325383-sdm-vol-2abcd.pdf)
supplies the RC/precision/destination rule.4,352 new constructor forms and
69,632 malformed laws pass alongside the retained720/8,640 CVTPI2PS gates.
262,144 independent official SoftFloat3e bit/inexact comparisons include all
four RC modes, full signed width populations and exact/halfway/limit edges.
SoftFloat is a test dependency only.163,840 independent Windows physical
RAX/FPU/XMM/MXCSR/tag/RFLAGS states match cold C compiler -> ordinary Wasm ->
C-MMU/table execution through80 modules, including45,658 precision exceptions.
Other GPR invariance is architectural, not a bare-metal all-register claim.

## Common raw IEEE relation

COMISS/UCOMISS/COMISD/UCOMISD use one raw-bit relation and precise publisher.
The relation consumes only the live32/64-bit regions, sign/magnitude and raw
NaN/denormal class bits. Signed zeros compare equal. DAZ applies before the
numeric relation. Ordered comparison raises invalid for either NaN class;
unordered comparison raises it only for signaling NaN. Unordered sets
CF/PF/ZF; normal comparison sets the prescribed relation; OF/SF/AF clear only
on successful retirement. Exceptions leave the old EFLAGS and all operands.

Independent hardware exposed **NaN-before-denormal**: even a quiet UCOMI NaN
that does not raise invalid suppresses denormal status from the other operand.
The shared SSA implements this distinction; expected/native states were not
repaired. Alias input selects one source column, without dropping NaN or
denormal effects. Current maximum graph61/span14 is an upper bound, not a
minimum.5,440 constructor forms/87,040 malformed laws pass;98,304 independent
physical states through256 modules match, including12,957 invalid/denormal
exceptions. Windows recovery/context codes are not asserted to be independently
measured x86 vector numbers.

## One MXCSR/exception owner, preserved MMX frontier

All these operations and the previously closed floating-to-integer forms now
use `cut_sse_raise`. It retains new flags independently of old sticky flags,
publishes MXCSR, checks masks and selects the existing #XM/#UD fault owner.
The raised slot is disjoint from MMX publication scratch. Construction facts
choose no MMX transition, transition before an unmasked fault, or transition
before either outcome. No mnemonic or numeric opcode crosses a VM import.
The older duplicated precision/fault emitters are deleted.

19,008 new integer-to-float and25,344 new comparison boundary models pass,
with384+512 complete-state residency retries. They cover #UD/#NM before access,
pending x87 independence, readonly/cross-page/canonical access, frozen host
residency and CR4.OSXMMEXCPT routing. The retained38,016 floating-to-integer
models and552 complete retries still pass. Deferred descriptors are promoted
by a serialized test owner, not claimed authenticated production recovery.

## General live comparison projection, red before green

The shared SSA emitter formerly spelled both unsigned-less and equality,
packed flags and extracted one bit even when only CF or ZF was live. One
bounded linear projection-demand scan now emits one Boolean for a single live
projection; the packed representation remains only when both are required.
Raw/unsupported views remain refused before any writer output.

`scalar-projection-check` pins exact CF-only/ZF-only/both instruction bodies
and254 malformed projections. Linked against the versioned `1dc6e69` emitter,
the CF-only gate fails **25 bytes vs12 required**; the current emitter passes.
The old emitter is only an ignored temporary negative-test input, never a
retained product path. No nested graph scan or runtime projection table is
added.

Paired execution keeps the **same current SSA, inputs, compiler and guards**
and changes only old/current scalar emission.7 alternating-order samples,
400,000 direct Node cuts/sample, include host RIP reset/assert overhead:

| Program | Old/new module bytes | Old/new median ms | New/old time |
| --- | ---: | ---: | ---: |
| i64 -> f64 | 1032 /861 | 12.9443 /11.5994 | 0.8961 |
| i64 -> f32 | 1052 /873 | 13.1214 /11.5466 | 0.8800 |
| UCOMISD | 1448 /1079 | 14.8882 /12.8929 | 0.8660 |

These are measured compiled execution/module reductions, not analysis speed,
native Linux performance, browser throughput or whole-release size claims.
Compiler itself grows348 bytes over that deliberately old-emitter baseline;
the saved program bodies shrink. Do not combine these unlike populations.

## Gates, products and reproduction

Scoped C compiler/postlink and positive ASan/UBSan pass without warnings;
464 existing postlink semantic witnesses remain green. The known unrestricted
intermittent native CALL RAM-payload red remains separately retained.
Previous physical populations remain green:131,072 float-to-integer,
46,080 CVTPI2PS,18,432 x87 stack,16,640 floating stores and8,448 raw loads.
The bounded same-bundle prefix retains86-cut/1,617,931-retirement witnesses.
Neither a signed complete image nor browser PID1/shell/cold3s/RSS is proved.

Candidate compiler737,990 bytes, SHA256
`b2a54ec6fb774af322bf1d9e4a628a46cc5dd405a4c924e7abac92cadcf1afbc`.
ABI4 VM stays99,070 bytes, SHA256
`61b9d2a49e38038105bf7cf0555346ff146be82a22bedf707918e539e5db11ea`.
Paired old-emitter compiler737,642 bytes, SHA256
`5a5ed58faac590b51bd094ffa0bb9bd79abb5db55cab7bd7dcc8cb37d2827175`.

```sh
make -C src/v2/x86 all
make -C src/v2/wasm-compiler all vector-integer-float-check float-compare-check scalar-projection-check
SCALAR-INTEGER-FLOAT-OBSERVER NEW-CONVERSION-DIRECTORY
FLOAT-COMPARE-OBSERVER NEW-COMPARISON-DIRECTORY
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-CONVERSION-DIRECTORY --scalar-integer-float
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-COMPARISON-DIRECTORY --float-compare
node data/oracle/check-vector-conversion-boundary.mjs VM.WASM COMPILER.WASM --integer-float
node data/oracle/check-vector-conversion-boundary.mjs VM.WASM COMPILER.WASM --float-compare
node data/oracle/bench-scalar-projection.mjs OLD-EMITTER-COMPILER.WASM COMPILER.WASM NEW-CONVERSION-DIRECTORY
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Continue the remaining generic floating arithmetic, selectors and far-control
families to ZERO, then publish and exercise the complete browser objective.
