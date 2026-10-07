# Integer-memory arithmetic: real red before lowering — 2026-10-08

The first published make gap remains `da2503005548` / FISUB m32. Its reusable
signed coercion is green at `c0370ff`; add/sub arithmetic is **not** implemented.
The new strict common C-Wasm/C-MMU/table gate refuses the independently
observed FISUB `da25fa0f0000` with -102. It is an arithmetic-family red, not the
same displacement bytes as make. No software library or JS guest arithmetic
rescues execution. Native publication, human UI and VM remain unchanged.

## Independent observation, not a copied arithmetic implementation

`wasm-compiler/check/x87-arithmetic-observe.c` calls real Windows x86 code in
the existing no-wait FPU/RFLAGS capture helper. Code is RX during observation;
integer data occupies a separate RW page. No compiler is called by this oracle.
576 forms = three operations x signed16/32 x four PC x four RC x six mask
contexts. Each form has 64 rows: zero, +/-1 and signed width extrema crossed
with sixteen 80-bit/occupancy inputs, with varying physical TOP/flags.

The 80-bit inputs include a one-ulp pair at one, cancellation, signed zeros,
minimum/max subnormal, pseudo-denormal, minimum normal, maximum finite,
infinity, quiet/signaling NaN, unsupported encoding and empty stack. Capture
retains complete physical FPU payload/tag arrays and architectural state,
not only a numeric result. **36,864 hardware rows** include 4,460 pending
unmasked errors and **2,096 payload changes while pending**.

The important negative result is that comparison's suppression rule cannot
be generalized to arithmetic:

| Newly unmasked exception | Changed payload | Unchanged payload |
| --- | ---: | ---: |
| IE | 0 | 1,152 |
| DE | 0 | 1,152 |
| OE | 116 | 0 |
| UE | 168 | 0 |
| PE | 1,812 | 60 |

These count payload equality only; an unchanged payload does NOT mean no
status/FOP/FIP/FDP/tag effects. They describe the local hardware matrix, not
universal CPU certification. GPR invariance is architectural; RFLAGS/FPU are
actually captured. A waiting instruction is not inserted in the capture gap.

`data/oracle/check-x87-arithmetic.c` independently uses official SoftFloat
only for the canonical finite, masked, non-reserved-PC subset: **2,880 result
and OE/UE/PE-bit comparisons pass**. 33,984 rows remain outside this reference
gate but are retained for the complete-state compiler gate. In particular,
PC=01, noncanonical/empty input and unmasked state publication are not certified
by SoftFloat. Its [documented noncanonical limitation](https://www.jhauser.us/arithmetic/SoftFloat-3/doc/SoftFloat.html)
is not waived. DE/stack state is checked by the physical records, not that
numeric library. Product code never links SoftFloat/TestFloat.

A tininess-before reference was genuinely red: form 0 / row 7 rounds the
maximum subnormal to the minimum normal at precision24. The native result
has PE but not UE; tininess-before expected UE+PE. Switching the reference
to tininess-after makes the complete stated subset agree. This fixes the
reference's configuration, not an expected-result patch or an implementation
of unknown arithmetic.

Official TestFloat's separate slow reference also reports no errors in
**1,115,136 extF80_add/sub tests** (24 x 46,464), three precisions x four
rounding modes x two operations, with tininess-after. Reproduce with
`prepare-float.ps1 -Arithmetic`. Original upstream sources/licenses/pins stay
under data; build outputs and the 92.9 MB-scale observation population are
ignored Windows temp files, never distribution artifacts.

## The next pure normal form and its obligations

For accepted finite operands, use explicit significands, not f64. After the
already-derived exact integer conversion, a finite value is

```text
value(m,e,s) = (-1)^s * m * 2^(max(e,1)-16383-63)
E           = max(max(e_A,1), max(e_B,1))
U_A         = (m_A << 64) / 2^(E-max(e_A,1))
U_B         = (m_B << 64) / 2^(E-max(e_B,1))
```

These equations denote exact rational values, not C shifts or integer
truncation. Apply operation signs, order finite magnitudes, and reduce the
result to a high significand word plus low word/discarded-nonzero residual.
Guard/sticky classification must survive alignment, carry/borrow and left
normalization; it cannot be thrown away at conversion or before cancellation.
Integer operands are finite; noncanonical A, NaN and occupancy require separate
semantic predicates BEFORE applying the finite-value law.

Why a bounded residual is plausible here: with canonical nonzero operands,
exponent gap zero/one can cancel deeply, but alignment loses no source bits
from the two-word representation. At gap >=2, the smaller magnitude is less
than 2^62 at the larger operand's scale, while the larger is at least 2^63;
subtraction can left-normalize by at most one. Lower discarded bits can then
be quotiented by the rounding observations (guard/tie/nonzero), not by keeping
arbitrary history. Zero/subnormal and unsupported cases need their own proven
premises; this observation is NOT an implemented global minimum proof.

After normalization, precision p is 24/53/64 for the defined PC encodings.
Round once from the exact residual: nearest-even distinguishes greater than
half, exact half and retained parity; directed modes require sign and any
discarded bit. Preserve C1 and sticky exception meaning. Signed exact zero
needs operation/sign/RC rules, not a generic zeroing of the sign bit.
Masked overflow/underflow result and unmasked scaled register result are
different observations of that same residual. IE/DE can suppress publication;
unmasked OE/UE/PE cannot reuse a blanket suppression branch. A future numeric
SSA must produce the selected exact result and outcome through this one law,
then existing state/event owners publish it. No runtime opcode evaluator,
opaque math callback or saved SSA is justified by a masked numeric pass.

The complete hardware gate therefore precedes claiming admission: payload,
tag/TOP, SW/CW/FOP/FIP/FDP, flags, retirement, memory-fault priority and deferred
event continuation all remain obligations. None is hidden behind a coverage
percentage or a fixture's native result.

## Real descriptor defect and regression scope

Before this work, FIADD/FISUB/FISUBR read FOP from source bytes 0/1. For prefix
66 / signed16 FIADD, the expected normalized argument was `607020c`, but the
actual was `6de020c`. `x86/check/x87-integer-arithmetic.c` was red against that
implementation. FOP now comes from decoded opcode/ModRM, the same source law
as FILD/compare. **48 forms** across eight prefixes/widths/operations pass.
This is NOT support for arithmetic execution. Full x86/compiler/postlink
checks are warning-free; the test does not override the existing make check
recipe. Unknown arithmetic still refuses -102.

ONE `check-x87-integer-memory.mjs` C-MMU/table driver now serves FILD and this
arithmetic gate; the old FILD-only script is removed. FILD's 12,288 complete
comparisons and 18 native/cold byte forms remain green with the latest compiler.
Cold compiler is 504,728 bytes / SHA-256
`b4e1c47d5cc1a68128039d7685978a394916aa1aec5bcd0dd1a0b9717b828991`.
VM stays 95,012 bytes / `92d917f30526f46b00554202de16fcfc0f5eae5f0af537ebc554bfc74b01be5c`.
There is no new arithmetic coordinate recovery, signed Linux root, browser
boot, speed/size/RSS or cold-shell claim.

```text
make -C src/v2/x86 x87-integer-arithmetic-check
powershell -File data/oracle/prepare-float.ps1 -Arithmetic
observe-arithmetic NEW-HARDWARE-DIRECTORY
arithmetic-oracle NEW-HARDWARE-DIRECTORY
node data/oracle/check-x87-integer-memory.mjs VM.wasm COLD.wasm NEW-HARDWARE-DIRECTORY --arithmetic
```

Build the Windows observer with support/machine include paths and normal GCC
warning flags. Build `check-x87-arithmetic.c` with those includes plus official
SoftFloat include/library paths, SOFTFLOAT_FAST_INT64 and LITTLEENDIAN. The
last command is deliberately strict and currently fails at the real FISUB
grammar miss; it does not count refusal as execution success.
