# SPEC.md

# Quotient Minimizer — Product Specification

Quotient Minimizer is a local-first machine-code minimizer.

The interactive product runs entirely in the browser:

```text
C / C++
  ↓
Clang/WASM
  ↓
optimized assembly
  ↓
Quotient Minimizer/WASM
  ↓
semantic quotient
  ↓
normalized operations
  ↓
minimal physical representative
  ↓
verification
```

The free interactive experience requires no account and performs compilation and optimization on the user's machine.

Server-side functionality is reserved primarily for automation, persistent state, shared corpora, native execution, batch processing, CI, and paid API access.

---

# 1. Paste Code

The first screen is a code editor.

The user pastes a small C or C++ function.

Example:

```c
uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            m & ((1u << i) - 1)) << (8 * i);

    return r;
}
```

No login is required.

The code remains local to the browser by default.

Primary action:

```text
Optimize
```

Secondary actions:

```text
Load Example
Clear
Share Source
```

`Share Source` must be explicit and opt-in.

---

# 2. Select Source Compilation

The browser compiles the input locally using Clang/WASM.

Default:

```text
Compiler: Clang
Optimization: -O2
Target: x86-64 baseline
```

Advanced source settings may include:

```text
-O1
-O2
-O3

x86-64
x86-64-v2
x86-64-v3
x86-64-v4
```

`-O2` is the recommended default.

The purpose of the compiler is not to perform the final minimization.

It acts as a frontend normalizer that removes ordinary source-level noise before QM extracts semantics.

The UI displays the generated assembly.

Example:

```text
Source
  14 lines C

Clang -O2
  37 instructions
```

The user may expand the assembly view but should not need to understand it to continue.

---

# 3. Define Observation

By default, the entire function result is observable.

```text
obs(y) = y
```

Therefore no output bit is implicitly treated as don't-care.

The observation quotient is defined by:

```text
obs : Output -> Observable

y ~ y'
iff
obs(y) == obs(y')
```

The default mode is:

```text
Exact output
```

Advanced users may explicitly select another observer.

Examples:

```text
Observe low 8 bits
Observe HIGH bits only
Observe zero/nonzero
Observe selected output fields
Custom bit mask
```

QM must never infer don't-care bits merely because they are constant over the current test domain.

Don't-care information comes from the declared observer.

---

# 4. Extract Semantics

QM converts the compiled program into a semantic representation.

For small finite domains, exhaustive execution may be used.

Examples:

```text
8-bit input
→ 256 inputs

16-bit input
→ 65,536 inputs
```

For wider domains, QM selects probes according to the detected structure.

Possible strategies include:

```text
basis probes
boundary probes
finite exhaustive execution
native execution oracle
symbolic extraction
CEGIS / SMT fallback
```

Control flow is not preserved merely because the compiler emitted branches.

If the input domain is finite and tractable, all paths may be executed and collapsed into the resulting input/output semantics.

Example:

```text
76-instruction branchy compact8
→ finite semantics
→ dynamic compaction
```

---

# 5. Apply Semantic Quotients

QM removes distinctions that are not observable.

There are two distinct quotient stages.

## 5.1 Observation Quotient

Current output values are equivalent when the explicit observer cannot distinguish them.

```text
y ~ y'
iff
obs(y) == obs(y')
```

This removes output distinctions that the API contract explicitly declares irrelevant.

## 5.2 Future Quotient

States or intermediate representations are equivalent when no allowed future continuation can distinguish them.

This can remove:

```text
state handoff
transition tables
history
destination arrays
intermediate ranks
temporary representations
```

The two quotient types must remain separate.

Observation quotient asks:

```text
Can the caller distinguish these outputs?
```

Future quotient asks:

```text
Can any continuation distinguish these states?
```

---

# 6. Normalize the Remaining Computation

The current QM corpus normalizes small bit-vector kernels into four major semantic classes.

```text
POINT
LIN_CONST
CONV
PERM_DYN
```

These are semantic classes, not instruction names.

## POINT

Lane-local or locally nonlinear operations.

Examples:

```text
zero detection
comparison
range predicates
carry isolation
Boolean selection
run boundaries
```

## LIN_CONST

Constant GF(2)-linear maps.

Possible physical representatives include:

```text
PDEP with constant mask
PEXT with constant mask
shift/XOR network
constant CLMUL
GFNI affine/linear transform
```

`LIN_CONST` must never be treated as another name for `PDEP`.

## CONV

Convolution over bit or lane indices.

Parameterized by physical multiplication family and lane width.

Examples:

```text
CONV(IMUL, 8)
CONV(IMUL, 4)
CONV(CLMUL, 1)
CONV(CLMUL, 64)
CONV(CLMUL, 128)
```

## PERM_DYN

Runtime data-dependent permutation, gather, scatter, compaction, or expansion.

Examples:

```text
PEXT with dynamic mask
PDEP with dynamic mask
dynamic shuffle
compact
expand
```

The set of semantic classes may expand in future versions.

The product must not claim that arbitrary machine programs necessarily fall into these four classes.

---

# 7. Derive Guards

QM derives representation guards from the physical operation.

A guard is required when accumulation can escape the intended representation.

The basic rule is:

```text
quotient/truncation is trivial
→ guard cost = 0

escape correction is linear
→ guard may be deferred and amortized

escape correction is nonlinear
→ guard must be paid before accumulation
```

Examples:

```text
IMUL carry
→ nonlinear
→ isolate/widen lanes first

CLMUL mod x^64
→ truncation
→ zero explicit guard

GF(2^128) reduction
→ linear
→ defer reduction until after XOR fold
```

---

# 8. Synthesize Candidate Programs

QM searches only after quotienting and normalization.

Specialized solvers are preferred over general search.

Examples:

```text
linear basis solver
constant enumeration
truth-table exhaustive search
finite-domain exhaustive verification
```

General CEGIS/SMT should be used only when specialized solvers do not close the problem.

The primary search objective is lexicographic:

```text
1. span
2. work
3. L(z)
4. rank
```

These are declared product objectives.

They are not claimed to be the unique possible optimization objective.

---

# 9. Report Residual Freedom

QM does not return only one program.

It returns:

```text
(program, residual freedom)
```

Interpretation:

```text
0
    no solution exists in the current search family

1
    the physical parameters are uniquely forced

n > 1
    n solutions remain tied before canonical rank selection
```

Examples:

```text
ranks8 exclusive
    502 solutions

inclusive_rank8
    1 solution

prefix_parity_mask8
    1 solution

quote_state_before8
    502 solutions

ranks16_nibble
    26 solutions
```

A zero result refers only to the current grammar/search family.

It does not imply that the target function is globally impossible to implement.

---

# 10. Select Target ISA

The user chooses one or more physical targets.

Initial presets:

```text
x86-64 baseline
x86-64 + BMI2
x86-64 + BMI2 + PCLMUL
x86-64-v3
AVX2
AVX-512
portable scalar
```

Future targets may include:

```text
ARM NEON
ARM SVE
RISC-V
custom ISA profiles
```

The semantic program remains independent of the physical target.

ISA lowering selects physical representatives.

Example:

```text
LIN_CONST
→ PDEP on BMI2

LIN_CONST
→ shift/XOR/multiply sequence on portable scalar

LIN_CONST
→ GFNI on a suitable x86 target
```

---

# 11. Lower to Physical Instructions

Each semantic operation may have several physical representatives.

QM must search among them rather than fixing one mnemonic per semantic class.

Example:

```text
LIN_CONST
    PDEP
    PEXT
    CLMUL
    GFNI
    shift/XOR network
```

The chosen physical program minimizes the configured objective.

The result distinguishes:

```text
core operations
standalone machine instructions
estimated microarchitectural cost
```

These must not be conflated.

---

# 12. Verify the Result

Every emitted result is verified.

Possible verification modes:

```text
exhaustive
basis-complete
finite tagged exhaustive
random differential
symbolic
certificate verification
```

Examples:

```text
8-bit mask
→ exhaustive 256 / 256

16-bit mask
→ exhaustive 65,536 / 65,536

linear 64-bit transform
→ complete basis verification

wide payload transform
→ basis + random differential verification
```

The UI clearly displays verification strength.

Example:

```text
Verification

Exact exhaustive
256 / 256 inputs

PASS
```

The product must not present random testing alone as a proof of global equivalence.

---

# 13. Show the Result

The primary result page should answer four questions immediately.

```text
What did the compiler generate?
What did QM reduce it to?
Why is it valid?
How strongly was the result forced?
```

Example:

```text
Clang -O2

37 instructions


Quotient Minimizer

2 core operations

PDEP
IMUL


Residual freedom

502 solutions


Verification

256 / 256
Exact
```

---

# 14. Explain the Derivation

An expandable explanation shows the transformation path.

Example:

```text
Input
    Clang -O2 assembly

Semantics
    8-bit mask -> 64-bit rank word

Observer
    exact uint64_t

Observation quotient
    identity

Normalization
    LIN_CONST
    CONV(IMUL, 8)

Candidates
    511

Valid solutions
    502

Canonical representative
    minimum rank

Lowering
    PDEP
    IMUL
```

This explanation is a core product feature, not debug output.

---

# 15. Show Alternative Targets

The same semantic target may be lowered for multiple ISAs.

Example:

```text
x86 BMI2
    2 core ops

portable scalar
    5 core ops

AVX2
    ...

AVX-512
    ...
```

The user can compare targets without recompiling the source semantics.

---

# 16. Show Known Primitive Recognition

When a known semantic primitive is recognized, the UI names it.

Examples:

```text
exclusive rank8
inclusive rank8
prefix parity
quote-state-before
select
compact
expand
stable partition
run IDs
Morton dilate
Morton compact
block offsets
```

Recognition is informational.

Correctness must continue to derive from semantics and verification, not from the primitive name.

---

# 17. Benchmark Locally

Optional local benchmarking may compare:

```text
original compiler output
QM lowering
alternative physical representatives
```

The benchmark runs on the user's machine.

Results must be labeled with the actual local CPU.

Metrics may include:

```text
cycles/item
throughput
latency
code size
instruction count
```

The UI distinguishes:

```text
semantic core-op count
actual assembly instruction count
measured cycles
```

---

# 18. Export

Free users may export the interactive result locally.

Formats:

```text
assembly
C intrinsics
plain C fallback
JSON result
verification report
semantic description
```

Export remains client-side.

No account is required.

---

# 19. Public Canonical Corpus

QM may optionally maintain a corpus mapping semantic targets to known physical minima.

Conceptually:

```text
semantic identity
× observer
× target ISA
× grammar version
× objective version
→ canonical result
```

A public snapshot may be distributed to the browser.

The browser may perform local lookup.

Raw user source and raw proprietary assembly are never automatically contributed.

Contribution is explicit opt-in.

---

# 20. Anonymous Contribution

After solving a previously unknown target, the user may choose:

```text
Contribute Result
```

Possible contributed fields:

```text
canonical semantic key
observer description
target ISA
grammar version
objective version
minimum result
residual freedom
verification certificate
solver version
```

Raw C and assembly are excluded unless explicitly selected.

Contributed results enter an untrusted candidate state until independently verified.

---

# 21. Free Interactive Product

The free product is designed for human interactive use.

It includes:

```text
local C/C++ compilation
local QM solving
local verification
standard ISA profiles
interactive result explanation
local benchmark
local export
public corpus lookup
```

The interactive solver may be used without a paid account.

The free product is not the automation API.

---

# 22. Paid API

Machine access is a separate paid product.

Base URL:

```text
https://api.example.com/v1/
```

Authentication:

```text
Authorization: Bearer <API_KEY>
```

The paid API must not depend on browser sessions, Turnstile, or free frontend credentials.

Initial endpoints:

```text
POST /solve
POST /batch
POST /verify
POST /lower
GET  /results/{id}
GET  /usage
```

---

# 23. Paid CLI

The official CLI uses the paid API.

Examples:

```text
qm solve kernel.c
qm solve kernel.s
qm verify result.json
qm targets
qm batch kernels/
```

The CLI supports machine-readable output.

```text
--json
```

It is designed for automation rather than interactive experimentation.

---

# 24. CI Integration

Paid users may run QM automatically in CI.

Example workflow:

```text
compile changed hot kernels
→ extract semantics
→ run QM
→ compare with previous minimum
→ publish result to pull request
```

Possible CI policies:

```text
report only

fail if canonical work increases

fail if minimum span increases

suggest newly discovered lowering

detect compiler regression
```

CI is a primary paid boundary.

---

# 25. Batch Processing

Paid API users may submit multiple kernels.

Examples:

```text
whole directory
generated kernel family
multiple ISA targets
multiple compiler outputs
```

Batch processing supports:

```text
concurrency
deduplication
semantic cache
result aggregation
```

---

# 26. Private Semantic Cache

Paid users receive private namespaces.

A private cache may store:

```text
semantic keys
canonical results
verification certificates
target profiles
historical measurements
```

Source code retention is disabled by default.

Private semantic data is not added to the public corpus without explicit opt-in.

---

# 27. Native Execution Oracle

Some programs cannot be fully handled by the lightweight browser semantic frontend.

Paid API may provide native or emulator-backed execution.

Use cases include:

```text
wide SIMD
unusual x86 extensions
native microarchitecture behavior
larger finite domains
environment-specific semantics
```

Possible execution backends:

```text
native x86-64
Intel SDE
other controlled execution runners
```

The execution environment must be sandboxed.

---

# 28. Private History

Paid users may retain result history.

Example:

```text
kernel foo

2026-08-01
    7 ops

2026-08-07
    5 ops

compiler changed
    Clang 22 -> Clang 23

new target
    Zen 6
```

History enables performance regression analysis and reproducibility.

---

# 29. Team Workspaces

Team plans add:

```text
shared private corpus
shared API quota
organization namespaces
result comments
CI integrations
access controls
audit history
```

---

# 30. Custom ISA and Microarchitecture Profiles

Advanced paid users may define:

```text
supported instructions
feature bitmap
physical lowerings
instruction costs
latencies
throughputs
uops
port pressure
code-size model
```

Semantic classes remain independent of these profiles.

ISA legality and microarchitecture cost are separate layers.

---

# 31. Enterprise Deployment

Enterprise options may include:

```text
on-premises QM
private cloud
self-hosted semantic corpus
custom execution oracle
custom ISA
proprietary instruction semantics
no-retention mode
SLA
support
```

---

# 32. Author / Expert Escalation

A high-touch paid option may allow a difficult optimization case to be escalated for manual analysis.

This is separate from the automated solver.

Possible deliverables:

```text
manual derivation
new grammar rule
new primitive
benchmark analysis
integration advice
```

Capacity is intentionally limited.

---

# 33. Non-Goals for Initial Release

The first version is not intended to solve arbitrary programs.

Initial focus:

```text
small functions
fixed-width integers
small vectors
register-heavy kernels
bounded control flow
deterministic semantics
```

Not initially modeled as ordinary pure functions:

```text
RDTSC
RDRAND
CPUID-dependent behavior
syscalls
port I/O
privileged instructions
concurrency
data races
self-modifying code
faults as observable outputs
```

These require explicit environment, nondeterminism, fault, or memory-model semantics rather than merely adding opcodes.

---

# 34. Product Principle

The product should preserve one simple distinction:

```text
Interactive optimization
    free
    local
    human-driven

Automation
    paid
    persistent
    API-driven
```

The free product should be genuinely useful rather than a deliberately crippled trial.

The paid product should earn its price through:

```text
automation
CI
batch
private state
persistent history
native execution
shared corpora
integration
support
```

The monetization boundary is workflow, not access to the basic idea.

---

# 35. Core Product Promise

The shortest description of the product is:

> Paste a small C function and see how little machine computation its observable meaning actually requires.

Internally:

```text
source
→ compiler
→ semantics
→ quotient
→ normalized action
→ minimum physical representative
→ verification
```

The product does not merely shorten assembly.

It removes distinctions that no declared observer or future computation can detect, then chooses the cheapest remaining physical representative.
