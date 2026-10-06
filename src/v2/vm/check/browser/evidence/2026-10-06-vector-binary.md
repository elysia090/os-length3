# Common vector binary law — 2026-10-06

## Actual gate and required change

The [completed aa750ea same-bundle run](2026-10-06-node-startup-pcmpeqd-red.json)
passes SHUFPS and retires 229,117,402 source instructions /
124,477,220 admissions. The next compiler -102 is
`66 0f 76 c0` (PCMPEQD xmm0,xmm0), RIP `0x7f1159591ddb`.
The frozen compiler/VM were 455,822 / 70,499 bytes. There is an /init
announcement, but no proven PID 1/root mount/shell or browser acceptance.

Engine construction is 507,555 ms, cold emission 421,207 ms, actual C execution
113,947 ms, supply 2,209 ms and total check 1,261,153 ms. The owner constructs
12,062,033 engines and evicts 12,061,290 under unchanged quotas. These counts
are not a speedup against a run with different work and active-time calibration.
The run handle was kept alive while redirected files appeared empty; completion
returned exit 0 and the final/progress files. It was never restarted on an
observation timeout.

The old compiler already decoded these bytes; its backend rejected the
transfer. Adding another opcode callback would retain the wrong boundary.
Packed additions and logic were also scalarized into word masks, shifts,
separate arithmetic and two publications despite a direct SIMD spelling.

## Substitute first, emit the normal operator

For width w, arithmetic is `r_i = (a_i + b_i) mod 2^w`.
Equality is `r_i = -(a_i == b_i) mod 2^w`.
Bitwise operations apply to the same complete 128-bit value. A same-register
input is equality of coordinates, not a sampled equality of payload:

```text
a == b coordinates:
  equal(a,b) = all ones
  xor(a,b) = 0
  and-not(a,b) = 0
  and(a,b) = a
  or(a,b) = a
```

The source memory operand can never inherit this alias proof merely because
its bytes happen to equal the register. Its complete aligned read and #UD/#NM/
memory-fault order remain mandatory before publication.

`x86/vector-binary.c` owns this lane-parametric law and exact descriptor
admission. Native instruction-to-SSA admission validates it.
`wasm-compiler/emit-vector-binary.c` consumes its operator, width, source order
and substitution result. It has no instruction mnemonic or scalar-lane loop.
AND_NOT is first & ~second, so the x86 frontend supplies source-before-old-
destination order for the x86 ~destination & source operation.

PADDB/PADDW/PADDD/PADDQ and the admitted bitwise families become one standard
vector operation; PCMPEQB/PCMPEQW/PCMPEQD use standard lane equality.
Identity removes the output publication; constants do not read XMM payload.
All three self-equality widths produce one byte-identical compiled body.
The old `lower-vector-arithmetic.c` and the scalar two-word logic block are
deleted; build checks refuse reintroduction.

The opcode spelling follows the official
[WebAssembly SIMD encoding](https://github.com/WebAssembly/simd/blob/main/proposals/simd/BinarySIMD.md)
and [core instruction contract](https://webassembly.github.io/spec/core/binary/instructions.html).
This is deterministic standard SIMD, not relaxed SIMD or a scalar fallback.
Constant splat, guards, transfer and retirement are reported separately from
the one data operation; this is not a global native work/span certificate.

## Red, independent observations and verification

The frozen 455,822-byte compiler returns -102 for the actual stop bytes.
The candidate admits them. Fresh observe-only native records and strict
emissions use the same source/seed; expected observations are not weakened.

The shared x86 check covers 2,992 decoded laws, 188,768 descriptor refusals
and 2,720 distinct valid operator alternatives. The latter are legitimate
changes to the typed operator, not claimed malformed encodings. Native
admission consumes the same law.

The [green receipt](2026-10-06-vector-binary-green.json) records:

- 432 native-C/cold-C byte-identical emissions.
- 55,296 unchanged native CPU/RAM observations, in direct and C-dispatch
  execution; 110,592 RF comparisons.
- 78,272 fault comparisons of the same 19,568 independent native fault frames
  in four executions, not four independent oracle populations.
- 896 separate per-lane equality/corner models, all three equality widths'
  exact constant-body sharing, carry isolation and required-SIMD refusal.
- Existing context/private-port refusal, physical wait/retry, byte-add
  exhaustive population and selector/shift/permutation models remain strict.

Native x86 runs in the independent reference build VM, not physical hardware.
CR0/CR4 and selected corners are model checks. Node engine execution is not an
actual browser observation.

Full x86, postlink and Wasm-compiler/CLI checks pass. The shared-core/native
ASan/UBSan route instruments support, x86 decoder/SSA, optimized ELF and
postlink, and explicitly runs both vector-law checks. This is not a complete
VM/device/browser/distribution sanitizer claim.

## Exact size scope

For the same 128 preexisting add/logic forms, complete generated modules sum
61,066 -> 56,306 bytes (7.8% smaller). Selected distinct-register forms:

| Form | old module bytes | candidate bytes |
| --- | ---: | ---: |
| PADDQ | 414 | 384 |
| PADDB | 506 | 383 |
| PADDW / PADDD | 506 | 384 |
| PXOR / PAND / POR | 414 | 383 |
| PANDN | 420 | 383 |

These are fixture module sizes, not canonical distribution bytes, fetched bytes,
RSS or measured Linux/browser acceleration. Candidate compiler is
456,366 bytes (+544), SHA-256
`39e35d9708a84a73a501ab88cfe67b8fa1b4b260784013bc5377a7961ce6694c`.
VM stays 70,499 bytes, SHA-256
`0c3142f523b4713e5034772569a73f32d6abe71f73c23d6da9bc45319c7e950f`.
The native publication and human UI remain unchanged.

## Remaining work

This candidate was not loaded in the completed aa750ea startup.
Run it against the same frozen bundle and observe the actual next gate.
The scalar register/ALU/flags/address emitter still needs to consume shared
normalized block SSA; this change does not silently claim that migration.
Whole-image/function/dispatch closure, legacy web/catalog retirement and the
full browser development/storage/network acceptance remain open. Cold shell
three seconds and the full active product goal are not achieved.
