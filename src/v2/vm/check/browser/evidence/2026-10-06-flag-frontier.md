# Retain the dependency relation, not a coordinate to decode again

## Fixed cost inside the same cold C compiler

The completed unchanged-bundle run has cold emission 273,294 ms as its
second-largest term, behind engine construction 321,690 ms. The bounded cut
compiler was decoding each accepted pure instruction four times: forward
admission, reverse flag dependence, dry body measurement, real body emission.
The reverse pass needed only the read/write/kill relation already derivable
from the first admitted descriptor. It was reconstructing that descriptor
solely to recover the same relation. This is linear duplicate work, not a
quadratic algorithm, a guest execution optimization or another compiler route.

## Exact relation in the existing one-word frontier

For instruction i let W_i be its write mask, R_i its read mask and K_i its
definite kill mask. The current accepted grammar has exactly K_i=W_i or
K_i=0: a register-count shift may preserve all incoming flags. Immediate
zero shifts already have W_i=0. Flag masks fit twelve bits. Store:

```text
summary_i = W_i | (R_i << 12) | ((K_i != 0) << 24)
```

This is not a decoded-instruction array or a coordinate history. It uses the
same four bytes per accepted instruction and carries only the dependence
needed by the reverse substitution. With outgoing live mask L=0xfff:

```text
wanted_i = L & W_i
L        = (L & ~K_i) | R_i
frontier_i = wanted_i << 16
```

The same word is overwritten with the final lowering input. No second
allocation, source payload materialization, VM state, row, report or ABI field
is introduced. The forward admission rejects an out-of-domain mask or a
future partial-kill relation rather than silently truncating it. Such a
grammar extension must update this exact projection. Precise isolated
memory/system cuts also retain their own relation; they are not assumed to
be flag-free. Measurement and emission still independently use the pinned
immutable source under the existing single-owner/no-shared-source contract.

## Mechanical red, same generated result, bounded cost

The new native wrapper counts actual `pl_x86_decode_profile` calls. Before
the change a one-NOP emission succeeds but fails the cost invariant:
4 decodes rather than 3. After the change, 231 cuts of length 1 through 1,024
verify exactly 3N emission decodes and 2N measurement decodes (formerly 4N
and 3N). Measurement and emission return the same complete report/length.
The test is a mandatory `make check` dependency, not a timing threshold.

Independent old/new C-Wasm compiler comparisons cover the same 231 rotated
patterns / 42,987 source instructions. They exercise carry chains, all eight
conditional read-mask classes, variable/zero/nonzero shifts, DF/CF control,
scans, multiply and dead definitions. Entire generated modules and all
80 report bytes match exactly. See the
[complete final comparison and timing](2026-10-06-flag-frontier-conditions.json)
and the [earlier 165-pattern measurement](2026-10-06-flag-frontier-micro.json).

Eight alternating 1,000-emission trials give median milliseconds:

| Source instructions | Before | After |
| --- | ---: | ---: |
| 1 | 5.251 | 4.666 |
| 8 | 19.048 | 15.875 |
| 64 | 131.836 | 108.043 |

Those are concurrent Node cold-compiler micro measurements, not isolated
browser/Linux or guest execution speedups. Generated work/span and stored
body size are unchanged; no release-size reduction is claimed. Compiler
binary grows 453,522 -> 453,800 bytes (+278) in exchange for removing the
reverse decode pass. VM remains 70,499 bytes, unchanged. Candidate compiler
SHA-256: `dd3400a9dc87f6358b33bb59a7088b5e387a80b15f58ea1355ad4ff89168c5f0`.

Fresh scalar/half native-cold regressions retain 156 byte-parity emissions,
9,984 unchanged native observations, 9,984 direct + 9,984 C-dispatch checks,
128 exact-half extent models and all faults/control/entry checks. The 118
LOCK-form native/cold regression retains 60,416 success / 59,904 actual
protection-fault comparisons, RF checks and 236 direct wait/retries. It does
not claim a separate dispatch run. Full native compiler/CLI checks and
scoped compiler ASan/UBSan frontier/code-cut checks pass; provider libraries
are not sanitizer-instrumented.

The same-bundle one-million-admission prefix compares
[50 non-clock/non-timing/non-size fields exactly](2026-10-06-flag-frontier-prefix.json):
1,617,931 retired instructions, exact architecture/trace/resource observations,
705 engine constructions and 1,075 engine hits. The explicit active-execution
clock poll counts differ; both complete raw receipts are preserved. No
elapsed ratio, boot success or equivalence of differing external time inputs
is asserted.

The full PID 7804 job still uses the separately frozen 453,522-byte compiler,
NOT this cost candidate. It is not restarted or overwritten. Obtain its
completed actual gate before the next frozen full measurement. The native
publication, human UI and retained browser Workers/staged assets are untouched.
PID 1, release-root mount, offline shell/tooling, actual browser acceptance
and cold shell 3s remain unachieved.
