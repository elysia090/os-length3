# Post-link compilation

## Motivation

A normal compiler turns source translation units into linked x86.  It cannot
use facts that become stable only after final layout, relocation, CPU feature
selection, kernel alternatives, static keys, and executable-page generation.
It also has no whole-machine obligation to close every possible byte entry,
fault, indirect transfer, interrupt, or device barrier.

The additional compiler starts from that final linked x86 and emits better
linked x86 with the same complete machine behaviour:

```text
linked x86 + load map + patch generation
    -> postlink-compiler
    -> optimized linked x86.                                   (1)
```

This x86 output is the primary result.  It must be independently loadable,
testable, executable, disassemblable, and benchmarkable on x86 hardware.  Its
correctness and speed do not depend on WebAssembly or a browser.

The browser is a second backend of the already obtained result:

```text
optimized linked x86
    +-> native x86 machine ABI
    \-> verified Wasm lowering -> vm.wasm machine ABI.          (2)
```

The two arrows consume the same post-link program and the same persistent-cut
contract.  WebAssembly lowering is not allowed to rediscover semantics, run a
different optimizer, or become the identity of the post-link result.

## What we want to obtain

The immediate product is an ordinary x86-to-x86 compiler with these
properties:

* the input is a linked ELF64 image or explicit raw executable map;
* the output is optimized x86 under an explicit machine-step ABI;
* every executable byte coordinate is compiled or is an exact architectural
  fault;
* the output can run and be benchmarked natively without a browser;
* a verifier proves input and output equivalent at every persistent cut;
* the result contains no interpreter instruction stream or runtime decoder.

The browser product then opens a real current 64-bit x86 Linux image and reaches
an interactive shell.  Linux itself owns processes, virtual memory, VFS,
dcache, page cache, signals, futexes, pipes, terminals, sockets, TCP, TLS, and
the toolchain.  The host supplies only machine events:

```text
block_read / block_write
console_read / console_write
clock
entropy
network_poll.                                                   (3)
```

The user-visible target is:

```text
cold browser open
  -> real x86 kernel boot
  -> BusyBox shell
  -> compile and run C
  -> make
  -> git and HTTPS.                                             (4)
```

The cold shell target is three seconds, with zero missing blocks, bounded
resident memory, and worker release/recovery without losing committed dirty
state.

## Why the target remains x86

The source machine is x86 and the compiler claims to improve that machine.
Making WebAssembly fast would not prove either of the following:

1. the x86 result is a real independently useful post-link compiler output;
2. the reductions came from machine semantics rather than a browser-specific
   runtime shortcut.

The first performance gate is therefore native:

```text
F_input_x86(h) = F_output_x86(h) for every finite event history h, (5)

cycles(output_x86) < cycles(input_x86)
```

on the declared workload and hardware, together with retired source
instructions, emitted x86 instructions, physical work, dependency span,
branch count, and memory traffic.  WebAssembly results are reported only after
this gate passes.

### Paired native measurement

Every measurement unit uses the same input and deterministic event trace for
the linked and optimized ELF. Let `B_i` and `O_i` be paired native cycles and
let `w_i` be the occurrence count of that unit in the declared workload. Whole
workload speedup is:

```text
system_speedup = sum(w_i * B_i) / sum(w_i * O_i).               (5a)
```

The arithmetic mean of `B_i/O_i` is not reported: it lets many cheap units
outvote a few dominant units. A typical multiplicative ratio may be reported
separately as the weighted geometric mean:

```text
typical_speedup = exp(sum(w_i * log(B_i/O_i)) / sum(w_i)).      (5b)
```

Sample order is randomized in linked/optimized pairs on one pinned CPU. Cold
and warm populations are separate. Cycles are primary; retired instructions,
branches and misses, LLC misses, page faults, physical work, and span explain
the result. Unequal block/quantum sampling uses inverse selection probability
before applying (5a). A paired bootstrap confidence interval that includes
one is inconclusive, not an improvement. Complete cold boot and tool invocations
are also measured end to end; block samples cannot prove away scheduling,
cache, delivery, or barrier interactions.

This also forces a clean architecture.  Decode, exact x86 semantics,
persistent-cut reduction, state closure, and program selection belong to the
compiler core.  Native x86 emission and Wasm emission are separate backends.
Neither backend may import the other.

## What this stage is not

It is not:

* a decompiler to C;
* a source optimizer keyed by function names or debug records;
* a hot-trace JIT that discovers correctness by execution;
* an x86 interpreter hidden behind generated handlers;
* memoization of previously observed inputs;
* a boot-trace specializer;
* a Wasm-only binary translator;
* a second VFS, syscall layer, or Linux compatibility layer;
* a compatibility reader that keeps an older format alive.

Runtime profiling may choose placement and residency, but it cannot supply
missing semantics.  An executable generation is not publishable until the
same compiler has closed it.

## Command-line contract

The mental model stays conventional:

```text
cc source.c -o program
postlink-compiler program -o program.opt
postlink-verify program program.opt
program.opt
```

The native output retains a normal linked-code identity and an explicit
machine-step entry for whole-machine use.  A separate backend operation may
derive browser modules:

```text
postlink-lower-wasm program.opt -o program.modules
```

That operation is a verified lowering of `program.opt`.  It does not accept
the original linked input and cannot bypass the x86 output.

## Input identity

The input identity includes every coordinate that can change x86 meaning:

```text
linked program = (exact executable bytes, load map,
                  relocation and patch generation)

decode context = (RIP, long/compat mode, operand/address size,
                  privilege and required CPU features).        (6)
```

Two equal byte strings under different decode contexts are not necessarily the
same instruction.  Conversely, CR3 and physical page coordinates do not belong
in a reusable pure arithmetic transfer after their mapping assumptions have
been proved separately.

## Output identity

The primary output contains:

1. bounded x86 transfer functions using the fixed native machine ABI;
2. a total mapping from executable page generation and byte offset to direct
   transfer or exact fault;
3. a minimum complete-future transition law at machine barriers;
4. canonical initial CPU and persistent-memory state;
5. exact linked-byte proofs authorizing each projection;
6. immutable resource identities, never storage locations.

The canonical executable identity is the optimized x86 program and its machine
contract.  Native layout, browser module layout, encryption, chunking, and
delivery are projections of that identity.

Correctness is:

```text
F_linked_x86(h) = F_optimized_x86(h).                           (7)
```

The browser backend adds an independent equation:

```text
F_optimized_x86(h) = F_wasm_projection(h).                     (8)
```

Equation (8) cannot substitute for (7).

### The global minimum is a residual-instruction machine

Ordinary optimized x86 is the primary executable projection, but its byte
layout is not the semantic normal form.  Let `C` be the fully linked closure
after load map, relocation, alternatives, static keys, CPU profile and patch
generation are fixed.  Source translation units, object members, functions and
symbols are absent from this point.  Direct fallthrough, jump and call/return
edges may be composed until an actual fault, indirect control, atomicity cut or
machine barrier prevents substitution.

For every exact pure transfer `t`, let `X(t)` be all direct x86 instruction
graphs admitted by the fixed CPU and machine ABI which realize `t`.  Each graph
has

```text
work(x) = number of retained direct x86 instruction occurrences,
span(x) = longest true data/fault/control dependency path,
code(x) = one canonical self-delimiting structural spelling.   (8a)
```

The compiler independently proves

```text
S_t = min { span(x) : x in X(t) },
W_t = min { work(x) : x in X(t) },
J_t = { x in X(t) : span(x)=S_t and work(x)=W_t }.              (8b)
```

`J_t` must be nonempty.  Otherwise the exact Pareto frontier is retained and
publication fails; no weighted sum chooses one physical resource over the
other.  Inside `J_t`, shortest global code and then length-lexicographic rank
select one representative.  Algebraic rewrites, constant/affine recognizers,
run finders and dictionaries only enumerate members of `X(t)`.  They do not
survive as representation tags.

Now split the selected graph immediately before each retained direct x86
instruction.  A residual state `q` has one immediate normal instruction law

```text
iota(q) = (architectural transfer, exact bound fields,
           ordered observation, work=1,
           live dependency-height transformation).            (8c)
```

and one total successor for every ordered outcome arm.  Complete-future
refinement is

```text
sig_0(q)     = iota(q),
sig_(n+1)(q) = (iota(q),
                (class_n(successor(q,a)))_(a in A(q))).        (8d)
```

Stabilization gives `Q`.  Equality of stable signatures is sufficient by
induction on every finite event history.  It is necessary because a differing
immediate instruction law is an immediate distinguisher and a differing
successor class has a finite distinguishing suffix.  Thus

```text
R = (Q, q0, iota, successor)                                   (8e)
```

is the unique minimum deterministic residual-instruction machine up to class
renaming.  Canonical signature order removes that final renaming freedom.
Several source instructions, functions or input files may have become one
class through substitution.  Conversely, a transfer which requires several
direct x86 instructions remains several residual states, so stored instruction
count, retired work and dependency span cannot drift apart.

Let `G` be the fixed globally prefix-complete construction grammar and let
`z(R)` be the least program in `G` which constructs exactly `R`.  The literal
branch guarantees an upper bound, while complete-future and physical cuts give
lower bounds.  Define

```text
S* = min_R worst_span(R),
W* = min_R worst_work(R),
M* = { R : future(R)=future(C),
           worst_span(R)=S*, worst_work(R)=W* },
R* = argmin { (L(z(R)), rank(z(R))) : R in M* }.                (8f)
```

This is the one released program identity.  The ordinary independently
runnable ELF `E_x86(R*)` and bounded modules `E_wasm(R*)` are exact execution
projections.  Their layout charges participate while candidates are compared,
but their byte strings do not replace `R*` as the quotient identity and may
not be retained beside it as a second executable owner.  Native publication
proves `future(E_x86(R*))=future(R*)` and benchmarks that ELF first.

The all-program frontier may be discarded only after every unresolved prefix
has a physical lower bound unable to improve `(S*,W*)`, or, inside that exact
fiber, a code lower bound unable to improve `(L,rank)`.  Search programs,
semantic rows, separate topology/parameter tables and materialized future rows
are build workspace and are deleted.

This is a physical, not merely information-theoretic, minimum. Let `G_x86` be
one globally prefix-coded grammar whose literal branch contains every finite
ordinary x86 ELF byte string and whose other branches contain structural,
quotient, affine, recurrence, and fixed-evaluator constructions. For grammar
program `z`, `emit(z)` is either one canonical ordinary ELF or finite reject.
The literal branch makes the grammar extensionally complete even before a
useful synthesis rule is added. Define

```text
S* = min_z max_(q,a) span_emit(z)(q,a),
W* = min_z max_(q,a) work_emit(z)(q,a),
M* = { emit(z) : span_emit(z)=S*, work_emit(z)=W* }.             (8b.1)
```

over physically closed `z` with the required complete future. An exact
dependency/barrier certificate supplies the lower bound; one concrete emitted
x86 candidate supplies the upper bound. Equality proves the global x86 span
and work minima only when the same candidate attains both. Grammar rules
improve the constructive upper bound and make dominated cells rejectable, but
never narrow the candidate population.

The performance coordinates are bounded by the grammar, not inferred from a
sample.  The primitive of the retained program is not a storage row or a
release-local operator tag.  It is one directly executable, canonical x86
instruction occurrence.  Each occurrence carries its instruction bytes and
one unit of work; its true input dependencies determine its height.  The
structural recurrences are

```text
serial(x,y)   = (span_x + span_y,
                 work_x + work_y,
                 bytes_x + bytes_y + frame)

parallel(x,y) = (max(span_x,span_y),
                 work_x + work_y,
                 bytes_x + bytes_y + frame)

choice(c,x,y) = (span_c + max(span_x,span_y),
                 work_c + max(work_x,work_y),
                 bytes_c + bytes_x + bytes_y + frame).         (8b.1a)
```

`frame` is an exact standard-ELF or instruction-layout charge, never a hidden
asymptotic constant. Sharing a complete-future class charges its body once in
`bytes`; execution still selects one occurrence, so it does not add the work
of every reference. A recurrence or loop is admitted only with a closed
physical bound or an explicit barrier/event cut. Thus a grammar derivation is
also a constructive, mechanically checked upper-bound proof for its emitted
ordinary x86 ELF.

#### Direct residual-instruction normal form

The transactional rSUBLEQ normal form is the model for the boundary, not a
second runtime.  After its pre-state row has been captured, one transition is
only

```text
result    = old + change
write     = (destination,result)
successor = result > 0 ? fallthrough : branch-or-event.        (8r.1)
```

`source`, decoded row kinds and every derived cache disappear by substitution.
The program is a graph of instances of one transition law; work is the number
of transitions that fire and span is the longest causal chain.  The direct x86
normal form must have the same property without embedding an rSUBLEQ evaluator.

Fix the release CPU profile and machine ABI.  For every accepted ordinary x86
instruction byte word `b`, let

```text
step_b(context,pre-state)
  = (ordered architectural writes, precise fault or event, next cut). (8r.2)
```

All operands are read from the pre-state.  Memory ordering, fault priority and
atomicity are part of the result.  Define the one-instruction quotient

```text
b ~=instruction c
  iff step_b(x) = step_c(x) for every accepted context and pre-state x.
                                                                    (8r.3)
```

Inside a class, the representative is the shortest ordinary x86 spelling,
then the lowest byte rank.  The hardware decoder and the fixed CPU contract
are the evaluator; no instruction-law table, opcode rank or semantic tag is
published.  `90` and `66 90` therefore have one representative, while two
instructions which differ only on a faulting input remain distinct.

The normalized barrier-to-barrier SSA is then covered by these actual
one-instruction laws.  A cover may fuse several SSA nodes when one x86
instruction implements their complete live transfer.  It may not split one
architecturally atomic fault or claim a zero-instruction cover for a
non-identity transfer.  For a selected cover `D=(V,E)`, where `E` is the true
data/fault dependency relation, define

```text
height(v) = 1 + max({height(u) : (u,v) in E} union {0})
work(D)   = |V|
span(D)   = max({height(v) : v is live at the next cut} union {0}). (8r.4)
```

Thus one emitted instruction is the necessary unit of work, while independent
instructions contribute work but not serial span.  Instruction count is not
used as a proxy for span.  Identity covers disappear; a load, store, atomic
operation or precise fault stays at its actual instruction cut.  The compiler
finds `work*` and `span*` independently over exact covers and publishes only a
cover attaining both.  If none does, it retains the Pareto frontier and fails.

Now take a residual control state `q` immediately before a selected
instruction.  Its immediate row is the canonical instruction transfer,
irreducible bound fields, ordered observation, and the transformation of the
live dependency-height vector.  The complete weighted quotient is the first
fixed point of

```text
signature(q) =
  (instruction-transfer(q),
   bound-fields(q),
   observation(q),
   for every ordered arm a:
     1,
     live-frontier-transform(q,a),
     class(successor(q,a))).                                  (8r.5)
```

The `1` is the single instruction occurrence.  A factored common prefix stays
on the incoming edge and is still counted.  A multi-instruction terminal
sequence is represented by multiple residual states, not by a storage row
whose work is supplied separately.

This fixed point is necessary and sufficient.  Equality of (8r.5) reproduces
one step, its exact cost/frontier transformation and equal successor classes;
induction on finite event words reproduces every future.  If two signatures
differ, the immediate instruction transfer, one bound field, one observation,
one frontier component, or a finite distinguishing suffix separates them.
Consequently the quotient is the coarsest congruence preserving semantics,
work and span.  Emitting one direct x86 body per reachable class is also the
minimum residual-state population: merging two classes changes a concrete
future, while retaining two copies of one class adds bytes without adding an
observation.

The last minimization is ordinary x86 layout over that quotient graph.  Branch
relaxation, fallthrough choice, shared tails, veneers, ELF headers and alignment
are charged together, and the exact final ELF bytes break ties only inside the
joint `(span*,work*)` fiber.  This is the x86 analogue of rSUBLEQ's one code,
one residual and one instruction: the retained bytes are the instructions
whose execution supplied the cost proof.

It follows that constant, affine, run, exception and dictionary alternatives
are compiler constructions, not Artifact storage modes.  An affine law may
win only by emitting the x86 instructions which generate it; those
instructions change `work`, the live frontier, `span` and final bytes in the
same candidate.  A storage encoder may not notice the affine law later, keep a
parameter row, and charge no execution for reopening it.  Exact immutable-byte
sharing and external delivery compression remain legal projections, but they
do not become another executable program representation.

#### Cost-preserving complete-future normal form

Semantic equality alone is too coarse for physical minimization. Before two
cuts may share an executable residual, each pure slice is normalized in this
order:

1. split at the actual fault, call, MMIO, interrupt, host-operation, and other
   observable barriers;
2. substitute constants and one-use identities, cancel store/load and
   call/return pairs when the persistent cut cannot observe them, delete dead
   nodes, flatten associative operators, order commutative operands, normalize
   predicate polarity, and densely topologically number the remaining SSA;
3. use lifted constants and coordinates only while enumerating exact
   one-instruction covers; bind the selected values into ordinary x86 fields
   and retain no parameter row;
4. compute exact residual work and the complete vector of dependency heights
   at every live output. Keep that vector until the next barrier; replacing it
   early by only its maximum loses composition information;
5. factor an executable common prefix or suffix only when graph substitution
   proves the factor. The factor and its actual work stay on the incident edge.
   Merely subtracting a numeric potential to make two costs equal is forbidden;
6. refine the finite partition to a fixed point with

```text
weighted_signature(q) =
  (observation(q),
   for every ordered arm a:
     residual_work(q,a),
     live_dependency_frontier(q,a),
     class(successor(q,a))).                                  (8b.1c)
```

This is the coarsest congruence that preserves architectural observation,
exact physical cost algebra, and every future composition. Syntactically
different histories with the same signature become one class. Equal output
values with different irreducible work or different frontier vectors do not.
Immediate weighted signatures receive canonical dense ranks by stable radix
ordering; complete-future partition refinement then returns the unique class
relation (final numeric ranks are immaterial and may be renamed). Thus the
compiler needs linear state columns rather than an all-pairs table.

Execution quotient and executable representation are the same residual graph.
Equal instruction transfer laws may share their build-side proof, but different
bindings are emitted as ordinary instruction fields unless the residual future
itself merges.  Equal immutable byte factors may still share one external
owner without changing the loader-visible Byte*, but no topology, parameter or
future row is retained as a second executable representation.  Only equality
of the full weighted signature merges execution classes.

The search grammar is intentionally complete and may be more expressive than
the result. After the proof closes, the retained grammar is the quotient
grammar of the classes above: the least residual expressive power sufficient
to reconstruct and execute the jointly minimal physical future. Universal
literal branches, candidate generators, and proof frontier are then deleted.

Information theory alone does not prove the first two coordinates. It proves
the rank/length obligation after the physical minima are fixed. The
complete-future dependency cut gives `S_lower` and the independent
necessary-operation cut gives `W_lower`; the grammar derivation gives
`S_upper,W_upper`. Publication requires

```text
S_lower = S_upper = sigma(E*)
W_lower = W_upper = tau(E*).                                  (8b.1b)
```

Only after one candidate satisfies both equalities may the Kraft frontier
discard constructions whose physical lower-bound pair cannot reach `(S*,W*)`,
or whose representation lower bound cannot beat the incumbent inside that
exact fiber. The literal-ELF branch guarantees a finite initial upper bound,
while the two physical lower-bound certificates make the performance search
close.

For each unresolved prefix cell `c`, the checker retains only a sound lower
bound

```text
lower_physical(c) <=componentwise P(emit(z)) for every z in c,
lower_representation(c) <= (length,rank) only when
                            lower_physical(c) = (S*,W*).        (8b.2)
```

An incumbent is globally accepted exactly when it has an exact physical
closure and no cell can improve either independent physical minimum or the
representation inside their joint fiber. Positive unresolved Kraft mass is
harmless only when every such cell is already unable to change that result. A
corpus hit, rewrite catalogue, or largest observed cost cannot replace (8b.2).

The certificate has two independent physical obligations and two
representation obligations inside their joint fiber. A dependency-cut lower
bound proves `S*`; an operation/data-dependence lower bound proves `W*`; the
same emitted graph must attain both. Then every cell in that fiber capable of
emitting a shorter canonical ELF, or an equal-length earlier ELF rank, is
rejected. These obligations are necessary and sufficient for (8a). They do
not require retaining a universal evaluator in `E*`.

#### Kraft-complete upper bound on native length

Raw ELF enumeration gives completeness but no compression theorem. The useful
upper bound comes from a proved fixed native evaluator family. Let `e[r]` be an
ordinary canonical x86 ELF with fixed ELF entry points, native instructions,
addresses, and non-parameter bytes, plus one uniquely encoded nonzero parameter
`r+1`. If the required complete future is proved to be one of the `N` futures
realized by `e[0]...e[N-1]`, physical closure first gives

```text
S_e = max span(e[r],q,a),
W_e = max work(e[r],q,a),              r<N, q in Q, a in A(q), (8c)
```

Let

```text
b = ceil(log2 N),
t = 2^b - N.
```

The canonical truncated-binary rank code uses `b-1` bits for the first `t`
ranks and `b` bits for the rest. Its Kraft sum is exactly

```text
t*2^(-(b-1)) + (N-t)*2^(-b) = 1.                              (8d)
```

This formula is for `N>1`; at `N=1` the sole rank has the empty code and Kraft
mass one.

It therefore gives the worst-case native length bound

```text
length(e[r]) <= C_e + ceil(b / 8) + delta_elf(r), r < N.        (8e)
```

where `delta_elf` is the exactly charged standard-ELF alignment/framing change,
bounded by the fixed family. This is an upper bound on the bytes of the final
ordinary ELF, not merely on a discarded build description. `e[r]` executes as
native x86. It contains neither a release-local table of `N` futures nor the
rSUBLEQ evaluator. Its fixed native code is the parameterized program itself.

This parameter width is information-theoretically exact. `N` pairwise
distinguishable complete futures require a prefix-free code with maximum length
at least `ceil(log2 N)` by Kraft's inequality, and (8d) attains that maximum.
`C_e` includes the fixed native evaluator, standard ELF shell, the family
prefix, and any family-count field required by the fixed contract; none is
hidden in the rank term. Byte packing has one canonical zero-padded spelling.

The complete Kraft coordinate is used twice without introducing two formats:

1. it partitions every possible construction/proof program, so a finite
   incumbent bounds every candidate that can still improve (8a); and
2. inside a proved fixed native family, it encodes only the future rank, giving
   the constructive bound (8e).

Thus every admitted family member has the constructive worst-case key
`(S_e,W_e,C_e+ceil(log2 N)/8+delta,rank)`. `S_e` and `W_e` range over every closed rank and
machine event, including paths absent from the profiling corpus. Average trace
cost, a timeout, or the largest cost merely observed so far is not a family
certificate.

Membership in the fixed family is mandatory. Without it, `ceil(log2 N)` is only
an information lower bound; an enumeration table or release-local dictionary
would merely move the linear term. The family constant, rank word, ELF shell,
and all alignment bytes are included in `length(E)`. Thus compression is proved
from complete-future quotient plus a native evaluator, never inferred from a
small class count alone.

The standalone compiler and distribution publication use the same physical
order with different exact length observers. The CLI literal observer charges
the complete ordinary ELF bytes. The Artifact publisher supplies a canonical
program `z` satisfying `decode(z)=E` and charges `L(z)` instead:

```text
rho_native(E)    = (|E|,rank_ELF(E))       for E in M*,
rho_release(E,z) = (L(z),rank(z))          for E in M*.         (8f)
```

This is not a second optimizer. Postlink supplies equivalent ordinary-ELF
candidates and their exact physical closures through one C interface; the
caller supplies a total length/rank observer. The literal observer is always
available, so the operation has a finite incumbent without Artifact. The
release observer may improve only the final two coordinates and must reproduce
every ELF byte. Artifact, Storage, Wasm, and VM types remain absent from the
postlink compiler.

## Derivation pipeline

### 1. Total executable-coordinate closure

x86 permits an indirect target at any byte coordinate.  The compiler catalogues
every byte of every published executable mapping, including aliases and edge
padding.

Each coordinate produces exactly one of:

* a completely decoded instruction under (6);
* instruction-fetch page fault;
* invalid-opcode fault;
* general-protection fault;
* another architecturally specified terminal cut.

Both arms of every direct conditional, direct call, jump, and fallthrough are
closed.  An indirect target uses the total page projection and never invokes a
runtime decoder.

### 2. Pure slices between machine barriers

Memory faults, MMIO, interrupts, host events, externally visible calls, and
executable-generation changes are barriers.  Instructions between barriers
form one pure state-transfer slice.

Loads, stores, ALU values, flags, and predicates form one typed SSA dependency
graph.  This graph is compiler evidence, not a runtime instruction set and not
a backend-specific representation.

### 3. Backward persistent-cut reduction

Liveness begins at the next barrier output and persistent state.  Values absent
from that backward slice are deleted.  Exact substitution removes a store
followed by same-address load, matching push/pop, caller return-address traffic,
flags overwritten before observation, and repeated full-state materialization.

Closed affine, Boolean, bit-permutation, recurrence, and memory-forwarding forms
are emitted directly rather than reconstructed as scalar chains.  Independent
values form one dependency wave; serial order remains only where dataflow
requires it.

### 4. Scalar binary floating-point as a physical slice

A scalar SSE instruction does not require an instruction interpreter. Decode
first produces one typed transfer containing the operation, source and target
classes, binary width, and immediate predicate. A binary64 word is carried with
the smallest routing address needed by its future arithmetic:

```text
bits -> (exponent, fraction-nonzero, quiet-bit)

route = finite-normal | subnormal | zero | infinity | quiet-NaN | signaling-NaN
```

The finite-normal class is the interval `1 <= exponent <= 2046`; its test is
the single unsigned interval predicate `exponent - 1 < 2046`.

The original 64-bit word remains the value. The route is only a residual
address, so a chain of scalar operations does not unpack the same XMM lane or
materialize the complete MXCSR after every source instruction. The carried
control class is:

```text
(route(left), route(right), rounding, DAZ, FTZ, exception masks).
```

For the finite-normal, default-rounding class, native x86 scalar operations and
Wasm `f32`/`f64` operations are the direct body. The five boundary classes and
non-default MXCSR classes use a finite exact integer-lane residual. Exception
flags combine with bitwise OR inside the slice and are observed once at the
next precise fault or machine boundary.

The same representation exposes stronger closed regions. A power of two has
no stored significand: a normal result is only a biased exponent field and a
subnormal result is one fraction bit. Affine exponent regions can therefore be
lowered from endpoint metadata and written once at the output boundary.

For a source-ordered run of exact power-of-two scales, retain only:

```text
ScaleCut = (total_delta, minimum_prefix_delta, maximum_prefix_delta).
```

If `A` executes before `B`, substitution gives the associative composition:

```text
total(A ; B) = total(A) + total(B)
minimum(A ; B) = min(minimum(A), total(A) + minimum(B))
maximum(A ; B) = max(maximum(A), total(A) + maximum(B)).
```

For input exponent `e`, the whole run is the exact three-word fast path when:

```text
1 <= e + minimum_prefix_delta
e + maximum_prefix_delta <= 2046.
```

The result preserves sign and fraction and replaces the exponent by
`e + total_delta`. The test covers every source prefix, so it does not erase an
intermediate underflow or overflow. A failed test enters the exact residual.
The C conformance check composes one million source scales into those three
words and performs one final materialization.

The same endpoint summary closes an ordered run of additions or subtractions
by exactly represented integer constants. Binary32 represents every integer
in `[-2^24, 2^24]`, and binary64 represents every integer in
`[-2^53, 2^53]`. Let the input integer be `x`. Under round-to-nearest, every
source addition is exact when the translated prefix region stays inside that
cell. Requiring the complete region to remain strictly on one side of zero
also removes the only signed-zero ambiguity:

```text
-2^p <= x + minimum_prefix_delta
x + maximum_prefix_delta <= 2^p

x > 0  =>  x + minimum_prefix_delta > 0
x < 0  =>  x + maximum_prefix_delta < 0
```

where `p` is 24 or 53. The ordered run then becomes one addition by
`total_delta` and one final IEEE materialization. A zero crossing, a
non-integer input, a value outside the consecutive-integer cell, or a different
rounding proof reaches the exact residual at the original source cut. Thus
conversion-to-float, a proved integer translation region, and a final
conversion or store need not create an architectural XMM/MXCSR frame between
source operations.

This does not authorize arbitrary floating-point reassociation. In general,
`(a+b)+c` and `a+(b+c)` are different binary64 programs. A recurrence or moment
form replaces the ordered source only when its proof establishes exact
representability for the complete input region, or when the source contract
explicitly permits a stated approximation. Otherwise only state
materialization is removed; the source arithmetic order remains.

### 5. Upper-bound the state population before storing it

Enumerating `N` observed states proves only a lower bound: another history may
reach state `N+1`.  The compiler first constructs a finite summary `S`,
`|S|=N`, with total transition `delta` and output `o`:

```text
summary(initial) = s0
output(r) = o(summary(r))
summary(step(r,e)) = delta(summary(r),e)
delta : [0,N) x Event -> [0,N).                                (9)
```

Equation (9) holds for every reachable concrete cut and every event.  Induction
over all finite histories proves that the complete-future quotient `Q` satisfies:

```text
|Q| <= N.                                                       (10)
```

Only after this upper bound exists does partition refinement minimize `S`:

```text
P_0(s)     = class(o(s))
P_(n+1)(s) = class(o(s), (P_n(delta(s,e)))_(e in Event)).       (11)
```

If every remaining rank is reachable and all pairs are distinguished at the
fixed point, then `N <= |Q|`.  Together with (10):

```text
N = |Q|.                                                        (12)
```

The output stores `E(N)`, `s0`, and total programs for `delta` and `o`, plus
exact exceptions.  It does not store `N` rows merely because the compiler used
a vector while proving (9).  For a fixed evaluator with no exceptions, state
extent grows as `O(log N)` rather than `O(N)`.

The same rule applies to transfer classes, topology classes, immutable extents,
dispatch functions, and resource populations: a total `[0,N)` generator and
exact coverage must bound `N` before representation is chosen.

### 6. Complete-future minimization

Two persistent cuts share one rank only when every later event history has the
same result.  Refinement (11) computes that right congruence, not a bounded
history sample.

Equal successor ranks remove a branch.  Predicate complement plus arm exchange
has one spelling.  Constants and relative targets are substituted before
ranking.  A closed successor's raw RIP, symbol name, backend function number,
and discovery order do not define a future class.  An unclosed target remains
an exact immediate observation: replacing two different absolute exits by one
equal relative displacement would change the resulting machine RIP.

For the finite reachable x86 boundary set `S`, define `o(s)` as the normalized
architectural transfer at `s`, excluding only static successor coordinates
whose targets are members of `S`.  Such targets become arms of a total
two-arm transition `delta`.  A one-successor block duplicates its arm and a
terminal or external exit uses an absorbing arm; its terminal result or exact
external address remains in `o(s)`.  The executable relation is therefore:

```text
s ~=x86 t iff o(s) = o(t)
             and delta(s,a) ~=x86 delta(t,a) for both arms a.  (12a)
```

This condition is sufficient by induction on the remaining event history.
It is necessary because unequal `o` is distinguished immediately, while a
different stable successor class supplies a finite distinguishing suffix.
Partition refinement computes exactly (12a); no history-depth parameter is
present.  Source instruction count, source span, and source spelling are proof
and cost data, not terms of `o`.

Equation (12a) proves semantic body identity only.  It does not by itself
authorize two observable x86 entry addresses to become equal.  Address-taken
symbols, materialized code pointers, unwind/fault metadata, and any declared
instruction-pointer observation form a separate placement obligation.  A
later emitter may use one body, distinct entry veneers, or distinct bodies,
but must choose the minimum legal form without weakening that obligation.

Let `A` be the closed finite set of linked code coordinates that can be
materialized as values by the accepted ELF ABI: dynamic function symbols,
non-control relocations to executable coordinates, indirect-control table
values, and allocated dynamic, lazy-binding, unwind, fault, or alternatives
metadata.  Let `mu` map admitted source coordinates to optimized coordinates.
The placement condition is:

```text
mu is injective on A,
resolve_output(mu(a)) = mu(resolve_input(a)),
rewrite(field(a)) decodes to mu(a), for every retained field.     (12b)
```

The first clause is necessary because a context can materialize two members
of `A` and compare them.  The latter clauses are necessary because direct
control and metadata consumers observe the mapped coordinate.  Together with
(12a), they are sufficient for the declared coordinate-renaming ABI: every
code-address producer and consumer commutes with `mu`, and execution after
resolution has the same complete future.  A raw static symbol that is neither
published nor referenced is construction history and does not enter `A`.

The executable boundary population is likewise derived rather than guessed.
Let `G` contain the process entry, runtime-published function entries, every
member of `A` that can be entered, and every code target named by a typed
allocated runtime-metadata schema.  The reachable boundary set is the least
fixed point

```text
R = lfp X. G union direct_successors(X)
             union call_continuations(X)
             union resumable_system_continuations(X).             (12c)
```

This is sufficient because every executable history begins at `G` and each
later instruction boundary is supplied by its preceding decoded transfer.  It
is necessary because removing a member of `G` or a reachable successor removes
a declared execution, while adding any other coordinate admits an execution
that the linked ABI does not publish.

In particular, the place of a construction relocation is not a member of `G`.
The relocation identifies a field inside an instruction; it does not publish
the containing instruction as an entry.  With variable-length x86, that field
does not even determine a unique instruction start: two decodes can share the
same relocated displacement while differing in a prefix, trailing immediate,
and fallthrough.  A relocation field is therefore attached and rewritten only
after (12c) has proved the owning decoded instruction.  Treating relocation
places as roots is neither necessary nor sound.

The domain of (12c) is code, not every byte on an executable loader page.  If
allocated `SHF_EXECINSTR` sections are present, their disjoint union is the
exact linked code image.  `PF_X` merely grants page execute permission and
does not publish neighbouring constants, notes, alignment bytes, or padding
as instruction starts.  Only a stripped image with no section boundary falls
back to its `PF_X` file extents.  Taking the union of both domains invents
executions and makes `N` proportional to non-code bytes; taking less than the
section image loses a published code coordinate.  This rule is therefore both
the upper and lower code-domain condition.

Decode membership and retained loader bytes are related but not identical.
Within one source `PT_LOAD`, a gap between executable sections which is not
owned by any allocated non-executable section is link construction padding.
It joins the moved executable interval and is not retained at its old virtual
coordinate.  If an allocated rodata, note, metadata, or data section intersects
the gap, that interval remains pinned and separates the executable intervals.
This ownership test is necessary to avoid deleting observable data and
sufficient to remove every unowned alignment byte without decoding it as x86.

Runtime ranges are half-open.  If `[a,b)` ends at the end of one executable
map and the next executable map begins after a virtual-address gap, `b` maps
to the output end of the last admitted block in the first map.  Concatenating
map-local coordinate arrays makes that one-past coordinate numerically equal
to the next map's first coordinate, but it does not make their virtual
boundaries equal.  Projecting `b` through the next map would make unwind and
fault metadata describe unrelated code.  The map identity therefore remains
part of the ephemeral boundary projection until every half-open metadata range
has been rewritten; it is not stored in the optimized ELF.

Let `C` be the number of complete-future classes, let `|A|` be the number of
observable entry coordinates, and let `C_A` be the number of future classes
which contain at least one member of `A`.  One coordinate can serve both as a
class body and as one observable entry in that class.  Every other observable
address must remain distinct, so the exact coordinate lower bound is

```text
minimum executable entry coordinates = C + |A| - C_A.             (12d)
```

It is achievable by choosing one member of `A` as the body coordinate in each
observable class, sharing one body for every other class, and using only the
remaining `|A|-C_A` entries as distinct veneers or equivalent distinct
spellings.  Thus (12d) is both a lower bound and a construction target; source
block count and relocation count are not output populations.

Consequently, one body per complete-future class is only a semantic lower
bound.  A class with several members of `A` needs distinct observable entries.
The physical candidates are shared body plus distinct veneers, distinct
bodies, or a position-independent shared spelling.  Their exact encoded
lengths are compared; a fixed veneer or one body per source block is not the
normal form.

### 7. Whole-ELF minimum construction

For one exact transfer future, local candidates retain the componentwise
physical Pareto frontier:

```text
(irreducible dependency span, total physical work).             (13)
```

Only candidates with the same physical pair are locally reduced by complete
encoded length and canonical rank. The first selection uses the native x86
cost model and emits x86.  Every
candidate is verified over its complete finite domain or by an exact symbolic
identity.  Probe agreement is falsification evidence, not proof.

This local frontier supplies alternatives and exact lower bounds to the global
selection in (8a); it is not a release decision.  The compiler composes body
sharing, observable entry veneers, dispatch, retained immutable intervals,
metadata rewrites, segment partitioning, and final file layout, then measures
the resulting ordinary ELF. Release requires a build-side certificate that no
unresolved universal-program cell can physically dominate the incumbent or
improve representation inside its exact physical fiber. Thus block quotienting
can help construct the minimum but cannot substitute for the whole-ELF proof.

The Wasm backend later lowers the selected transfer graph.  It may choose legal
instruction encodings for Wasm but cannot reopen semantic candidate selection
or produce a different persistent-cut quotient.

### 8. Native x86 emission

The ordinary ELF shell is derived from runtime memory observations, not copied
one input segment at a time.  Subtract every moved executable interval from
the input `PT_LOAD` file projections.  The remainder is a finite ordered set
of retained intervals.  For each retained byte at virtual coordinate `v`, the
output loader map must return the same byte at `v`; zero-fill intervals retain
their memory extent without acquiring file bytes.  The compact executable
interval instead maps the selected code spelling at `mu(v)`.

These conditions are necessary: dropping a retained byte changes a possible
load, duplicating an interval adds avoidable output, and overlapping owners
make relocation resolution ambiguous.  They are sufficient because the ELF
loader observation is exactly the partial function from virtual coordinates
to file bytes or zero-fill plus flags.  Non-`PT_LOAD` headers such as
`PT_NOTE`, `PT_DYNAMIC`, and unwind views name ranges in that function; they
are relocated views, not separately copied payloads.

For a retained interval beginning at virtual address `v`, its file placement
`f` satisfies the ELF congruence `f mod align = v mod align`.  Compatible
adjacent intervals may share a `PT_LOAD`; doing so charges the intervening file
span.  Splitting charges one program header and the next congruence padding.
The canonical partition is the minimum encoded byte extent over those two
choices, with segment count and lexicographic layout as deterministic ties.
Thus an input `PF_X` containing `.text`, `.rodata`, and a nested `PT_NOTE` does
not force the source code gap or a second copy of `.rodata` into the output.

Each selected transfer becomes ordinary x86 code with a fixed ABI such as:

```text
transfer(machine_pointer, executable_context) -> result.       (14)
```

Static successors use direct transfer ranks.  Dynamic targets use the total
page projection.  Memory operations call the native MMU and physical-page
boundary; a cold page returns a precise delivery result before architectural
locals are committed.

The emitted x86 is linked into an independently runnable output.  Disassembly,
native differential tests, instruction counts, dependency span, cycles, branch
misses, and memory traffic are first-class compiler outputs.

Only the emitted standard ELF crosses this stage boundary.  Construction
programs, universal-machine state, local-candidate tables, and the global
frontier have no ELF section and no loader path.

### 9. Secondary Wasm lowering

The browser backend mechanically lowers the accepted transfer functions and
machine ABI to bounded Wasm modules.  It binds their identity back to the
optimized x86 artifact and proves (8).

Static successors return direct function ranks.  Dynamic targets use the same
total page function.  Memory operations call the browser machine's MMU and
physical cache.  A module or page miss is a delivery barrier, not a decoder or
compiler entry.

No browser-only semantic optimization is permitted.  If a useful reduction is
found while lowering to Wasm, it must be expressed in the compiler core,
re-emitted as optimized x86, and pass the native gate before both backends use
it.

### 10. Canonical publication

Equal transfer futures, functions, immutable extents, and finite maps are
quotiented before physical encoding.  Reconstructable dense rows and proof
tables are deleted.

[ARTIFACT.md](ARTIFACT.md) defines the optimized x86 identity and exact storage
word.  [STORAGE.md](STORAGE.md) defines untrusted-tier delivery, encryption,
erasure, persistent roots, and recovery.  Wasm modules are authenticated
derived projections, not a replacement identity.

## Native machine ABI

The native runner owns only machine mechanisms:

* CPU persistent state and direct transfer table;
* physical RAM and MMU translation;
* exception and interrupt entry;
* virtual devices and event ABI (3);
* dirty COW pages, generation checks, and delivery leases.

It does not own a decoder, instruction switch, block compiler, VFS, or slow
execution route.  One emitted x86 transfer runs until another resident transfer
or a machine event.

This native ABI is the reference for the browser machine ABI.  Shared C headers
define state fields, event codes, memory ordering, and result publication.  A
backend-specific helper cannot silently change the state contract.

## Executable mutation

`exec`, `mmap(PROT_EXEC)`, kernel modules, alternatives, static keys, and text
patching create a new executable-page generation:

1. unpublish the old generation;
2. stop execution at its generation barrier;
3. compile every byte coordinate of the replacement outside the machine;
4. emit and verify the native x86 replacement;
5. derive and verify any required secondary backend projection;
6. atomically publish the new generation and transfer ranks.

The page is never executable between steps 1 and 6.  This is the same
incremental compiler contract, not speculative execution or an interpreter
fallback.

## Why the result can be smaller and faster

A normal compiler preserves translation-unit and object-file boundaries and
usually emits one physical instance per linked use.  The post-link compiler
sees the final finite machine and can remove information no longer
distinguishing:

* byte coordinates with the same complete transfer future;
* equal SSA topology under parameter substitution;
* branches with equal successor classes;
* direct edge tables already represented by emitted code;
* constants reconstructed from one shared topology;
* immutable extents already named elsewhere;
* dense page rows generated by a compact total function.

This is not compression after the fact.  First, a closed program bounds the
population from above.  Reachability and future distinction give the matching
lower bound.  Then the compiler selects the shortest and fastest x86 program in
that exact equivalence class and erases the construction data.

## Current measured position

The current C frontend has processed the official linked Linux image as:

```text
19,186,970 executable byte coordinates
13,957,016 direct blocks
 5,229,954 exact fault blocks
         0 lowering failures
   335,144 shared SSA topology functions
 9,608,716 residual states.                                   (15)
```

These are inventories, not yet the required upper-bound/minimality result.  In
particular, constructing 9,608,716 state rows and compressing them would retain
the wrong dependency direction.  The next analyzer must report the closure
upper bound `N`, the reachability/distinction lower bound, the total generator
program, and its exact exception count.

A version-6 browser projection has admitted a direct root and run 64 transfer
quanta without a missing block.  That validates one backend route only.  It
does not prove native optimized x86 exists or is faster, so it is not the
post-link completion gate.

The current 405,847,385-byte pack also serializes fixed dispatch rows, residual
state/edge pages, repeated descriptor constants, and two digest directories.
Those are derived layouts.  Artifact and storage bounds must replace them
before browser micro-optimization continues.

## Verification factory

Correctness and performance are established in this order:

1. generated x86 instruction-family differentials against independent decode
   and machine oracles;
2. block and conditional-pair fuzzing, including precise fault cuts;
3. complete 256-coordinate dispatch-map exhaustion;
4. complete linked-image coordinate closure and direct-edge audit;
5. input x86 versus optimized x86 native differential execution;
6. native benchmarks and retired-instruction/work/span measurements;
7. optimized x86 versus Wasm projection differential execution;
8. browser boot, shell, C compile/run, make, Git, and HTTPS;
9. Linux tests covering x86, signals, futexes, clone3, exec, timers, ptrace,
   pipe/IPC, memory management, TTY, seccomp, and networking.

Tests and oracles are build inputs.  They do not become runtime modules or
delivery artifacts.

## Completion conditions

The compiler is complete only when:

* it emits independently runnable optimized x86;
* input and optimized x86 satisfy (7);
* native measurements show the selected x86 reduces the declared physical
  objective;
* every executable coordinate is a direct transfer or exact fault;
* every direct target and both conditional arms are closed;
* every population has a proved finite upper bound before storage;
* every merge has complete-future equivalence evidence;
* runtime has no decoder, instruction switch, scalar fallback, or compatibility
  reader;
* executable mutation cannot publish an uncompiled generation;
* missing block count is zero by construction;
* the Wasm projection satisfies (8) without a second optimizer;
* delivery and worker release preserve bounded memory and exact resume;
* the browser reaches (4) through that derived projection.

## Implementation order

1. Freeze the backend-independent persistent-cut and machine ABI in C.
2. Derive and report population upper bounds before choosing storage rows.
3. Replace fixed dispatch/residual tables with total programs and exact
   exceptions.
4. Remove repeated descriptor constants and duplicate digest directories.
5. Project the result through STORAGE.md, prove complete lookup parity, and
   measure a material reduction from the old Linux pack.
6. Delete the old artifact/storage readers after parity; they are not retained
   as a fallback.
7. Emit independently runnable optimized x86 for the accepted canonical
   transfers.
8. Add input-x86/output-x86 differential and native performance gates.
9. Lower the accepted optimized x86 artifact to bounded Wasm modules and prove
   backend parity.
10. Rebuild the Linux distribution and measure cold browser boot.
