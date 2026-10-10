# Wide instruction input and transcendental execution checks

The frozen499-row/476838-record instruction population has zero missing
entries. All476829 ordinary records and9 deliberate architectural faults
compile to valid ordinary Wasm with exact source extents. False fault,
invalid module, wrong extent and wrong interface counts are zero. This is
instruction construction acceptance, not universal x86 or Linux boot proof.

## Fixed inputs and compiler

Assembly SHA256:
`9c92b02198a8f173dbb6a3f523cd3bf0e3aa7def60bd768047356363057e03d4`.
Instruction SHA256:
`84994b53b5a13d9e63a61ad05a01e04446fffad91faaed41b0a5f7bf491a5a56`.
The required population remains `development-standard-v2`; no row, operand
dimension, fault expectation or CPUID feature was removed.

The independently built cold compiler SHA256 is
`c6d10e6abd303d16490210a0a2c401069611a3371ae6b19fb51942832d011b67`.
The C VM SHA256 is
`800ea277ea8904a18f0c03c0bf75ae095708b1c3170f83f6d05ac8dcdec27e51`.
Both use the existing machine-entry ABI4 and memory feature set6. Emitted
numeric work has no host numerical import, interpreter or kernel-coordinate
rule. The product compiler emits common pure SSA directly into Wasm.

## Shared numerical form

Binary64 nearest-even working operations retain a compensated high/low
mantissa. A separate integer exponent preserves the full extended range;
working lanes never update guest MXCSR. The existing extended addition and
rounding projection consumes the two lanes once, with precise exception and
publication frontiers. Intermediate plans reuse the same bounded arena;
their values stay in Wasm locals, not an intermediate guest memory frame.

Trig reduction divides the exact integer numerator by
`P=0x3243f6a8885a308d3`. The reciprocal
`floor(2^192/P)=0x517cc1b727220a95000315e206d13b5f` underestimates the quotient
by at most one for the required128-bit numerator. One exact correction and
an odd-divisor nearest comparison produce the quadrant and signed dyadic
remainder. No binary64 quotient can lose a large-input quadrant. The reduced
argument includes the mathematical-pi/architectural-Pi correction described
in [Intel SDM Volume1](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-1-manual.pdf).

F2XM1 uses diagonal[11/11] Padé with exact rational coefficients
`c[k]=(22-k)!*11!/((22)!*(11-k)!*k!)`, splitting even and odd powers:
`expm1(t)=2*O(t)/(E(t)-O(t))`. It never subtracts a rounded exponential and
one. Tiny inputs retain their integer exponent.

Logarithms use `atanh(t)/t` Padé[6/6], matching the thirteen coefficients
`1/(2k+1)`. Normalizing the mantissa around one avoids cancellation near
`x=1`. FYL2XP1 starts at `t=x/(2+x)`, not a rounded `1+x`. The same fraction
with negative squared argument gives atan. Exact dyadic cuts51/256 and
171/256 and Möbius reduction keep its argument inside magnitude0.2.
Argument reduction, rational evaluation and quadrant recovery expand into
one ordinary machine function; no runtime opcode dispatcher is introduced.

## Independent execution populations

| Instruction family | State comparisons | Numerical and architectural scope |
| --- | ---: | --- |
| FSIN,FCOS,FSINCOS,FPTAN | 55296 each | 43008 standard states plus12288 unmasked-underflow states; independent fp128 error/C1 enclosures; other state bytes exact. |
| F2XM1 | 55296 | Physical CPU bit equality, including C1, exceptions, all tags and stack state. |
| FYL2X | 229376 | Scaled independent fp128 reference; own C1/tag;768 exact minimum-normal boundaries have independently derived underflow/pending-error/FOP meaning. |
| FYL2XP1 | 229376 | Defined-domain error and exact special/exception/stack checks;93184 out-of-domain cases test the explicit invalid representative, not skips. |
| FPATAN | 229376 | Scaled independent reference, axes, infinities, signs and exponent distances;3328 microscopic rounding cases use the analytic atan inequality. |

The physical comparison harness keeps full-state equality as a separate red
diagnostic. Approximation-contract tests verify the numerical enclosure and
the implementation's C1/tag before substituting those allowed observations.
They do not silently discard mismatched bytes. Out-of-domain and exact-boundary
cases are independently specified; all other exception and stack observations
still require exact comparisons. Intel's transcendental accuracy and FYL2XP1
domain are specified in
[SDM Volume1](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-1-manual.pdf)
and [SDM Volume2A](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf).

Pure working arithmetic has49152 native fp128 and49152 emitted-Wasm exact
rational comparisons. Final compensated rounding has131072 independent
significand/C1/PE/PC/RC checks. Integer angular reduction has131072 native
integer/fp128 and262144 emitted-Wasm exact integer/dyadic comparisons.
The separate quadmath target compares196608 sine/cosine, exponential,
logarithm, epsilon and arctangent values. These finite populations and observed
graph bounds are not global work/span minima or exhaustive64-bit state proofs.

## Reproduction and remaining product gates

Use the product Makefiles and `x86/sources.mk`, not a second source recipe.
`make -C src/v2/wasm-compiler angle-check compensated-check profile-additions-check`
checks the common constructors and exact arithmetic foundations.
`trig-check` is an explicit independent quadmath oracle target, never a
product numerical dependency. The Windows observers produce fresh exclusive
records; `check-x87-state.mjs` executes generated code through the real C VM,
MMU and function table. Its explicit `--trig-contract`, `--log-contract` and
`--angle-contract` modes state the approximation scopes; `--diagnostic` retains
physical bit mismatches and fails. `check-profile-inputs.mjs` validates the
entire independently assembled population without `--boundary` reduction.

Native release bytes, human UI, guest clocks and service deadlines are unchanged.
Normal browser offline service startup remains red. Whole-image executable
generation, debug/alignment contexts, page fault/retry, actual Linux services,
toolchain/VFS/network and lifecycle gates remain separate required work.
