# Executable artifact

## Responsibility

This document defines the semantic identity and canonical byte spelling of a
compiled machine.  It answers two questions:

1. which information must survive publication; and
2. which of the equivalent implementations is the released implementation.

It does not define where bytes are stored, how they are encrypted, how erasure
shards are placed, or which pages are resident.  Those are replaceable
projections defined in [STORAGE.md](STORAGE.md).  It does not define network
transport; that boundary is in [NETWORK.md](NETWORK.md).

The post-link command-line model remains ordinary:

```text
cc source.c -o program
postlink-compiler program -o program.opt
postlink-verify program program.opt
program.opt
```

`postlink-compiler` accepts linked x86 plus its load and patch context.  It
produces independently runnable optimized linked x86.  Native x86 is the
primary output and the first equivalence and performance gate.  Bounded Wasm
modules are a separately verified backend projection of that accepted x86
artifact; they are not its identity and cannot bypass it.  The product runtime
contains no x86 decoder, semantic interpreter, STEP reader, Python block
former, or JavaScript instruction implementation.  See
[POST-COMPILE.md](POST-COMPILE.md) for the compiler boundary.

One accepted program has one canonical residual-instruction machine and two
execution projections.  It is not identified by either projection.  Let

```text
R = (Q, q0, instruction, successor)                             (0a)
```

where `Q` is the reachable complete-future quotient over the disjoint union of
all linked inputs in the release.  `instruction(q)` is one canonical direct
x86 residual instruction: its complete architectural transfer, irreducible
bound fields, ordered observation, one unit of retired work, and exact
live-dependency-height transformation.  `successor(q,a)` is total for every
ordered arm.  A source function, object file, source instruction history,
decoded block, SSA node id, topology record and parameter row are construction
coordinates; none is a member of `R`.

The post-link compiler first substitutes and normalizes maximal pure regions
across fallthrough, direct jump and directly composable call/return edges.
Several source instructions may therefore become one member of `Q`.  When one
direct x86 instruction cannot realize the exact transfer, the transfer remains
several residual states.  Consequently the number of retained instructions is
the physical work count itself, and their true dependency relation supplies
span without storing a second cost table.

The native backend emits one ordinary x86 ELF `E_x86(R)`.  The browser backend
emits bounded Wasm modules `E_wasm(R)`.  Both are checked projections of the
same `R`:

```text
future(R) = future(E_x86(R)) = future(E_wasm(R)).               (0b)
```

ELF bytes, Wasm bytes, delivery pages and a materialized future table are not
additional executable authorities.  A projection may be cached, paged or
evicted, but publication retains the canonical code of `R` exactly once and
enough immutable non-program payload to regenerate the requested projection.
Keeping `R` and every emitted ELF body as independent owners is a rejected
double materialization.

For release-wide selection let `z(R)` be the single self-delimiting global code
of the residual machine.  The selection key is

```text
kappa_release(R) =
  (worst_span(R), worst_work(R), L(z(R)), rank(z(R))).          (0c)
```

`worst_span` and `worst_work` are minimized independently and must be attained
by the same machine.  If they are not, publication retains the exact Pareto
frontier and rejects.  Only inside that joint physical minimum do code length
and global rank select the unique machine.  Constant, affine, run and
dictionary recognizers may propose candidates during proof search; they never
become stored modes.  Every winning candidate is reduced to this same residual
instruction relation before it can be ranked.

Likewise, one Linux release root names the optimized kernel, optimized userland,
root filesystem, and toolchain once, then names separate native and browser
delivery projections. Profile-specific packing, module boundaries, and cache
coordinates are not Linux distribution identity.

## Observable machine

Fix every input that can alter x86 meaning:

```text
I = (linked bytes, load map, patch generation,
     decode mode, CPU features, initial persistent cut).
```

An event is a machine barrier input: a completed physical-page read, an
interrupt, a clock or entropy value, console input, or a device
acknowledgement.  For every finite event history `h`, define:

```text
F_I(h) = (barrier output, next persistent cut, committed dirty bytes).  (1)
```

Fault ordering, interrupt boundaries, executable-page generations, and dirty
bytes are observable.  Decoded instruction objects, SSA node ids, temporary
locals, page-cache slots, delivery offsets, and proof traces are not.

Two candidates may share one executable identity exactly when:

```text
A ~= B  iff  F_A(h) = F_B(h) for every finite h.                (2)
```

Agreement on a boot trace, a finite instruction sample, a source symbol, or a
hash prefix does not establish (2).

## Persistent-cut quotient

For reachable persistent cuts `s` and `t`, define complete-future equality:

```text
s ~=F t  iff  F_s(h) = F_t(h) for every finite h.               (3)
```

This is a right congruence.  Its reachable quotient

```text
Q = reachable cuts / ~=F                                       (4)
```

is the unique minimum deterministic state space up to renaming.  Any exact
executor needs at least

```text
p_min = ceil(log2 |Q|)                                         (5)
```

persistent state bits.

This is only a lower bound until closure supplies the other direction.  A list
of `N` observed states proves at most `N <= |Q|`; a longer history may still
reach a new future.  To prove an upper bound, the compiler constructs a finite
set `S`, `|S|=N`, a total transition `delta`, an output function `o`, and a
summary from every reachable concrete cut:

```text
summary(initial cut) = s0
output(r) = o(summary(r))
summary(machine_step(r,e)) = delta(summary(r),e)                (5a)
```

for every reachable `r` and event `e`.  `delta(s,e)` is defined and remains in
`S` for every `s in S`.  Repeated substitution proves that every finite future
factors through `S`, hence:

```text
|Q| <= |S| = N.                                                 (5b)
```

When every member of `S` is reachable and refinement (6) separates every pair,
the converse lower bound holds:

```text
|Q| = N.                                                        (5c)
```

The release contains `N`, `s0`, and total selected programs for `delta` and
`o`.  The concrete summary relation and proof are build-side certificates and
are deleted.  Runtime state is restricted to `[0,N)`; a transition outside the
interval is an invalid artifact rather than a state allocated on demand.

The storage term is therefore not `N` state rows:

```text
state_bits = |E(N)| + ceil(log2 N)
           + code_bits(delta,o) + exact_exception_bits.         (5d)
```

For a fixed total evaluator with no exceptions, growth is its constant code
plus `O(log N)`.  A table remains a fully charged fallback whose program length
is linear in `N`.

For a finite closure, partition refinement starts from complete barrier output
and repeatedly adds every event-arm successor class:

```text
P_0(s)     = class(output(s))
P_(n+1)(s) = class(output(s), (P_n(step(s,e)))_(e in Event)).   (6)
```

Every strict round only splits.  Stabilization is the complete-future
quotient, not a bounded-history approximation.  Ranks are assigned from the
stable signatures rather than RIP, discovery order, source symbols, or object
addresses.

The immediate consequences are mechanical:

* unreachable states are omitted;
* equal complete futures have one rank;
* a conditional with equal successor ranks is unconditional;
* predicate complement plus arm exchange has one spelling;
* a history cache is keyed by quotient state, never by history;
* a dense residual-state row is a disposable opened layout.

## Backward persistent slice

Between barriers, liveness begins at the next persistent cut and proceeds
backward.  A value absent from this slice cannot affect (1), so serializing it
cannot be necessary.

Store-to-load substitution, caller/callee composition, call/return stack
cancellation, flags substitution, and memory forwarding occur before the cut
is encoded.  The result is one finite law:

```text
machine_step : Q x Event -> Q x Output x DirtyPatch.            (7)
```

Intermediate full-state snapshots, decoded instructions, temporary SSA
values, and repeated materialization at internal cuts are construction data.
They are deleted after equivalence verification.

## Why byte compression cannot define the artifact

Let a reachable cut `s` denote the residual machine function

```text
R_s : Byte* x Event* -> Observation.                            (7a)
```

The required equivalence is `R_s = R_t` on the complete infinite history
domain.  A byte compressor instead receives one already chosen finite spelling
`z = serialize(s_0, ..., s_(N-1))` and minimizes a parse made from literals and
bounded-distance substring copies.  Its equality relation is therefore

```text
(position, length) equal inside one serialization window,               (7b)
```

not equality of (7a).  The mismatch has unavoidable consequences:

* two differently spelled cuts with the same complete future remain two rows;
* permuting rows changes compressed length although it changes no observation;
* a branch whose arms have the same future remains a branch;
* equal functions outside the copy window are not shared;
* a high-entropy table generated by a short affine, rank/select, permutation,
  or recurrence law remains a high-entropy table;
* the parse proves no total transition and therefore no upper bound on `N`;
* decoding reconstructs a byte prefix and history window before a direct
  coordinate is available, adding linear work and serial dependencies.

Consequently, applying Deflate to `N` materialized rows can reduce their byte
constant while preserving the wrong `Theta(N)` dependency.  It cannot justify
`N`, minimize the complete-future quotient, or select the executable physical
form.  Deflate is permitted only after the following information has already
been removed:

```text
complete cut closure
 -> Byte*/event complete-future quotient
 -> backward persistent slice
 -> total generator + exact exception support
 -> canonical program word
 -> optional byte compressor over the irreducible remainder.             (7c)
```

The optional last arrow is a storage projection.  Its decoder, framing,
touch amplification, work, and span are fully charged, and it never changes
semantic identity or population counts.

### The measured linear terms

The schema-2 Linux machine pack is 405,847,385 bytes.  Its C finalizer accounts
for 405,291,961 bytes (99.86%) as seven materialized linear families:

| opened family | bytes | missing normalization |
| --- | ---: | --- |
| immutable nonzero memory pages | 121,176,064 | exact page quotient and total logical-page-to-rank generator |
| residual edge rows | 76,863,360 | complete-future quotient, generated CSR endpoint, successor/delta generators |
| module payload and index | 71,208,337 | topology identity plus one parameter generator and exact exceptions |
| entry tail rows | 50,579,456 | total `(page, offset) -> function` generator instead of 256-cell rows |
| residual state rows | 31,830,528 | generated kernel/degree columns over the minimized state ranks |
| instantiation and parameter rows | 30,437,688 | strict CSR endpoints, shared records, and lifted constants stored once |
| resource and delivery directories | 23,196,528 | canonical-rank interval generators instead of locator rows |

Only 555,424 bytes lie outside those terms.  Therefore the storage blocker is
not a choice between several byte compressors.  Every large term has the same
shape: a total finite function is opened into rows or pages before its shortest
program is selected.

The required rewrite is column-wise substitution.  For each family, first
prove its domain and complete-future classes, substitute any CSR endpoint or
rank formula, select a total generator for each surviving column, and retain
only its exact exception support.  Deflate may then encode the concatenated
exception bytes.  It may not receive the opened row family.

For nonempty CSR byte records, strict monotonicity gives

```text
end(r) = offsets[r+1] > offsets[r] >= 0
address(r) = data[end(r)-1]
lookup(r) = values[address(r)].                                (7f)
```

The empty-history root, the state scan, and every transition cell disappear by
substitution.  If aggregation uses a monoid with an identity, absence is the
identity and its presence plane and branch disappear too.  Worker-local
256-lane tables then merge independently; no history state crosses a worker
boundary.  Deflate sees only non-generated exception lanes after this rewrite.

### Measured residual-edge substitution

The complete Linux closure contains `9,608,716` residual states and
`10,787,718` ordered edges.  The old edge resource used `21,070` pages of
`3,648` bytes, or `76,863,360` bytes: one `u24` next-state column and one
`i32` RIP-delta column per edge.  Profiling every edge proved that the latter
column was not independent information.  The successor-free kernel had
discarded its static target, and the edge row added the same target back.

Substitution gives one exact kernel result

```text
token(arm, delta) = ((uint32(delta) << 1) | arm),
result = (token << 3) | transition-kind.                       (7g)
```

The modular difference is accepted exactly when it is the sign extension of
one 32-bit word.  This includes a physical alias whose `rel32` crosses zero;
comparing the two absolute 64-bit coordinates would reject that valid case.
The token itself is an instantiation parameter, not a Wasm-body literal, so it
does not split equal SSA topologies.  The edge page is consequently only its
`u24` next-state column: `21,070 * 1,600 = 33,712,000` bytes.

The transition-token red-to-green measurements were:

| quantity | before | after |
| --- | ---: | ---: |
| edge-page bytes | 76,863,360 | 33,712,000 |
| shared SSA topologies | 335,144 | 335,144 |
| exact bodies sharing a topology | not recorded | 1,051,932 |
| projection pack | 269,198,633 | 244,302,957 |
| finalized pack with clean backing | 287,622,908 | 262,958,944 |

The transition-token finalized saving was `24,663,964` bytes (8.58%).  Storing the token as a
body literal was rejected: it increased the topology count to `676,080` and
saved only `1,744,441` projection bytes.  Lifting it restores topology sharing,
but increases fixed-width parameter storage from `24,068,936` to `37,159,376`
bytes.  That `13,090,440`-byte increase and the remaining next-state column are
the next finite functions to encode by (10)--(16), not reasons to restore the
deleted delta route.

Canonical first-coordinate rank order exposes the next substitution.  On the
same complete edge domain,

```text
predicted next rank = current rank + RIP delta
```

is exact on `7,188,730` edges.  A non-resolving mismatch is represented by the
signed correction

```text
correction = actual next rank - predicted next rank,             (7h)
```

while the `32,580` resolving edges use one distinguished exception code.  The
complete exception support therefore has `3,598,988` coordinates.  Absence from
that support means the predictor exactly, so no value, count, or presence byte
is stored for any of the other `7,188,730` coordinates.

The canonical physical page is `REDGE3`: a 64-byte header, a 512-bit complete
support bitmap, and eight independent groups of 64 exception codes.  Each group
uses its minimal bit width, including width zero, and records one canonical byte
offset.  Signed corrections are zigzag coded; only corrections outside that
finite code space use the absolute-rank escape.  Page extent is the exact used
prefix in `[128,2176]`, rather than a padded semantic row.  Runtime evaluation is
therefore

```text
next = support[edge]
     ? decode_exception(code[rank_support(edge)])
     : state + delta.                                           (7i)
```

The linked-image generator independently lowers every x86 edge again and checks
the opened result of (7i).  Publication is rejected unless all `10,787,718`
coordinates agree.  Thus the support is not a sampled profile or a runtime
fallback.

The complete Linux measurements after this substitution are:

| quantity | transition token | predictor plus exceptions |
| --- | ---: | ---: |
| edge-page bytes | 33,712,000 | 12,278,095 |
| total residual graph bytes | 65,542,528 | 44,108,623 |
| projection pack | 244,302,957 | 222,869,052 |
| finalized pack with clean backing | 262,958,944 | 241,525,039 |
| exact semantic edge checks | not recorded | 10,787,718 |

The final pack loses another `21,433,905` bytes (8.15%).  Relative to the
pre-transition-token final pack it is `46,097,869` bytes (16.03%) smaller.  The
remaining edge bytes are now the priced exception function itself; restoring a
dense next-state column or applying Deflate to its opened rows would reintroduce
the deleted linear term.

### Complete `Byte*` collapse

For byte input, the infinite history domain becomes finite only after a total
law is proved.  A particularly strong case is the right-zero law

```text
delta(q,b) = h(b)  for every q in Q and every b in [0,256).     (7d)
```

Exhausting all `|Q| * 256` coordinates proves that every nonempty history has
the same future as its final byte:

```text
delta*(q, w || b) = h(b).                                      (7e)
```

The transition table then has zero retained cells.  Runtime state is only the
canonical class of the final byte, and any quotient-invariant value is one
direct 256-coordinate function which can itself be constant, affine, packed,
or predictor plus exact residual.  If several bytes share `h(b)`, quotient
them again; 256 is an upper bound, not a mandatory table size.

Equation (7d) is the existing strongest `Byte*` cache law.  Publication must
recognize it from the general closed transition function, not through a
Python-only special route and not by noticing repeated serialized rows after
the fact.

### Canonical byte-region program

The preceding right-zero law is a special collapse, not the definition of an
immutable payload format.  The general observable is a byte function over a
family of regions.  Let canonical nonempty payload owners have ranks
`r in [0,M)`, extents `l_r`, and strict ends

```text
e_0 = l_0,
e_r = e_(r-1) + l_r,
C = {(r,o) : r < M and o < l_r},
B(r,o) = payload_r[o].                                       (7j)
```

Strictness makes

```text
flat(r,o) = (r ? e_(r-1) : 0) + o                            (7k)
```

a bijection from `C` to `[0,N)`, `N=e_(M-1)`.  It is a coordinate
substitution, not a request to construct `B[0..N)`.  Exact equality of `B` at
every point is necessary and sufficient for every bounded immutable read:
one unequal point is a distinguishing one-byte read, while repeated
substitution reproduces an arbitrary interval.

Therefore immutable bytes are another instance of the finite-function law
(10)--(16), not a mandatory final LZ/Deflate stream.  Let `p` range over one
globally prefix-coded grammar of total byte programs on `C`.  The grammar
contains, without semantic tags at runtime:

* structural ELF/archive/namespace generators already proved by earlier
  ranks;
* constant, affine, periodic, bit-plane, rank/select and region-moment laws;
* composition and coordinate substitution over canonical regions;
* prior-factor, dictionary and recurrence programs over the complete earlier
  coordinate domain; and
* the literal program as the terminating upper bound.

For a fixed `p`, direct substitution defines the only permissible residual:

```text
S_p = {c in C : B(c) != p(c)},
R_p(rank_S(c)) = B(c) xor p(c),  c in S_p.                    (7l)
```

`S_p` is encoded as its canonical subset/region-cut rank.  Equal corrections
are quotiented, and `R_p` is subjected recursively to the same construction
on the strictly smaller support.  A step with full support must select the
literal terminal and cannot recurse.  The selected word charges the global
program and inverse, support rank, distinct correction values, framing,
random-access/touch bound, work and span.  Rank of the one global program code
is the final tie break.  There is no release-local codebook.

This is necessary for a fixed program: deleting a support coordinate changes
the byte observed there, while retaining a coordinate outside the support
stores a value implied by `p`.  It is sufficient because (7l), inverse XOR and
(7k) reconstruct every point of (7j).  Outer minimality is established only
when every shorter admitted program/residual word has been eliminated; an
unclosed search reports its bit gap instead of claiming a normal form.

A prior-factor parse is thus one candidate `p`, useful when literal substrings
are the remaining information.  It is not a second compulsory pass after a
short affine, structural or recurrence program has already generated those
bytes.  Deflate is another admissible candidate only when its globally charged
decoder, window, touch and residual word win the same comparison.  Feeding an
opened `B[0..N)` to either codec before this selection is the forbidden
materialized route.

## Population bounds precede representation

The upper-bound rule applies to every population that could otherwise become a
linear artifact table.  Before bytes are assigned, the compiler names a finite
coordinate interval and proves a total generator:

```text
g : [0,N) -> Value.                                             (7a)
```

It also proves exact coverage:

* every semantic member maps to a rank below `N`;
* equal members map to the same rank;
* every rank below `N` is used;
* rank order follows canonical content or stabilized future, not allocation or
  discovery order.

Thus `N` is an upper bound before an array exists, and quotient coverage makes
it the exact population size.  This gate applies separately to future states,
transfer classes, topology programs, immutable content classes, delivery
intervals, and exception supports.

The artifact stores `E(N)`, a selected total program for `g`, and exact
exceptions.  It does not allocate `N` objects and then compress their rows.  An
implementation whose only evidence for `N` is a constructed vector length has
reversed the dependency order and is rejected.

## Canonical stored program word

The published Artifact spelling is one self-delimiting bit payload:

```text
code(z) = E(|z|) || z

E(0) = 0
E(n) = 1 || 0^floor(log2 n) || bin(n),  n > 0.                 (8)
```

The file appends the unique zero to seven zero padding bits.  The loader reads
one length, exactly that many payload bits, and rejects a nonzero padding bit or
a whole trailing byte.  Hence every accepted program has one byte spelling and
the framing cost is `O(log |z|)` bits rather than one header per section.

The payload denotes a finite-support, default-zero image:

```text
E(k) || E(root)
     || product(i < k) (E(address_gap_i) || E(zigzag(value_i))). (9)
```

Support addresses are strictly increasing and values are nonzero.  The fixed
VM ABI assigns meanings to image coordinates.  A release cannot add an
unaccounted local codebook, semantic tag table, scheduler checkpoint, or
release-specific decoder.  Dense zero spans, alignment padding, and repeated
coordinates have no support entry.

The word reconstructs the selected ordinary native x86 ELFs, their unavoidable
parameters, the initial quotient state, exact linked-code proof, and immutable
semantic bytes through public bounded reads. It does not contain a second
materialized copy of those ELFs or the data used to discover or prove them. A
Wasm module is a derived backend projection and cannot replace or define this
word. Conversely, the word is never passed to `execve` and never becomes a
guest instruction stream; its decoded logical resource is the ordinary ELF.

## One encoding for every finite function

Dispatch, residual transitions, topology parameters, immutable memory, and
resource incidence are finite functions.  They use one construction rather
than independent row formats.

Let `U` be a previously proved population bound, not the length of a
materialized vector.  Then let:

```text
x : D -> V,    |D| = U.                                       (10)
```

A candidate `p` is a canonical typed-SSA program that predicts a value at
every coordinate.  Its exact residual is:

```text
S_p = { d in D : x(d) != p(d) }
k_p = |S_p|.                                                   (11)
```

After `U` and `k_p` are known, the support needs the combinatorial rank of one
`k_p`-subset:

```text
support_bits = ceil(log2 binomial(U, k_p)).                    (12)
```

Equal residual values are quotiented.  If their multiplicities are
`n_0 .. n_(m-1)`, the assignment needs:

```text
value_assignment_bits
  = ceil(log2 (k_p! / product_j n_j!)),                        (13)
```

plus the recursively encoded distinct values and multiplicities.  These are
enumerative ranks, not aligned integer arrays.

The complete candidate cost charges its predictor, inverse, counts, support,
and residual values:

```text
C(x,p) = E(U)
       + code(p)
       + code(k_p)
       + subset_rank(S_p)
       + quotient(residual values).                            (14)
```

For ordinary physical minimization, select:

```text
p* = argmin_p (span(p), work(p), |C(x,p)|, rank(C(x,p))).       (15)
```

For a storage pass whose execution bounds are already fixed:

```text
p* = argmin_(p: span<=S and work<=W)
              (|C(x,p)|, rank(C(x,p))).                        (16)
```

The dependency order is fixed:

1. prove a finite closure and its bound `U`;
2. quotient equal complete futures or equal values and assign canonical ranks;
3. synthesize a total generator on `[0,U)`;
4. encode its exact exception support; and
5. select the least complete word under (15) or (16).

This is not a menu selected by a heuristic.  Familiar representations are
members of the same search:

* constant: constant predictor, empty residual;
* affine: affine predictor, empty residual;
* sparse default: constant predictor plus residual support;
* run: predecessor predictor plus change coordinates;
* CSR: support rank plus a value projection;
* bit plane: Boolean predictor plus subset rank;
* dictionary: quotient of equal residual values;
* table: complete-domain residual fallback.

The C finite-function selector now has a regression for the first nontrivial
instance of (14): exact constant and affine generators with a strictly ordered
sparse exception set.  It retains no domain-sized support plane and constructs
no exception row.  The writer may enumerate the original function once, rank
the support as one `k`-subset, and emit only the ordered mismatch values.  In
the fixed regression an affine `u32[256]` with three exceptions falls from
4,352 packed value bits to 100 generator/correction bits; a constant `u32[64]`
with two exceptions falls from 256 to 34 bits.  A 256-coordinate
piecewise-constant function with two changes falls from 1,024 value bits to a
37-bit initial-value/change list.  A 64-cell `u64` function with a shared high
prefix and one nearby exception falls from 4,096 to 89 bits, or 18 bits when
the semantic role already supplies the generator.  Exception payloads are
XOR corrections from the total predictor, so reconstructible high bits are
not stored.  No case carries an `N`-bit support plane.  This is a grammar gate,
not a new Linux size claim: the native emitter must consume the selected form
before the historical 103,103,419-byte checkpoint changes.

The selector was also run over the actual linked `vmlinux` block catalog, not
only the fixtures.  The input has 9,593,485 executable byte coordinates and
1,268,283 complete block-function classes.  Opening the page-local
`coordinate -> class rank` function as `u32` cells costs 306,991,520 bits
(38,373,940 bytes).  Selecting constant, affine, sparse-exception, run, or
packed form independently for each contiguous at-most-256-coordinate group
costs 93,717,741 payload bits (11,714,718 rounded bytes), before format
framing.  It avoids 4,958,431 individual value cells but still retains
4,635,054 exact values.  The 37,477 groups select respectively
16,496/0/19,165/110/1,698/8 instances of
constant/affine/constant-exception/affine-exception/run/packed.

This measurement is deliberately a red diagnostic.  It neither changes the
historical Linux checkpoint nor licenses an 11.7 MB rank resource.  Only eight
groups still fall back to a full row, but 4,635,054 exact values remain.  More
importantly, canonical native execution does not require a second
coordinate-rank family at all: direct control belongs in the independently
runnable optimized ELF.  The browser projection derives its dispatch from
that accepted ELF.  Publishing the measured rank function as a separate
Artifact population is therefore forbidden even when its bytes are well
compressed.

The same catalog performs an independent second pass that binds both static
arms through the complete coordinate-rank map and forms the direct native
control product.  It closes all 9,593,485 coordinates: 7,535,013 arms select a
direct function, 119,854 enter the total address resolver, two results are
machine barriers, 2,615,616 are precise fault functions, and 7,056 are exact
halt terminals.  No result is a successor-free graph-transition token, so the
retained residual-state and residual-edge row counts are exactly zero.  This
proves that a separate graph is unnecessary for the measured linked image;
native code emission still has to consume this direct product before the
product CLI may turn green.

The parameter family is measured at the same semantic boundary.  The
1,268,283 block classes contain 49,575,130 bytes (396,601,040 bits) of opened
typed parameter rows.  Exact whole-row sharing alone leaves 40,691,572 bytes.
Instead, classes are partitioned by their already-shared SSA topology; every
`u64` constant and `u16` frame coordinate/index becomes a finite function over
that topology's canonical instance order.  Selecting generator plus exact
subset rank for each at-most-256-instance group, while also substituting each
instance's representative RIP and selecting `value - RIP` when shorter, costs
70,723,247 payload bits (8,840,406 bytes), before format framing.  Of
10,628,711 typed values, 5,860,509 are generated and are not stored
individually; 4,768,202 remain exact values.  The 1,903,232 groups select
180,587/725/28,823/1,315/17,497/1,674,285
constant/affine/constant-exception/affine-exception/run/packed forms.
43,520 groups use the origin-delta bijection, so their absolute 64-bit
addresses are never retained.

Constants remain the largest typed term: opening them costs 302,055,552 bits,
while topology-local generators and corrections cost 59,397,088 bits.  Frame
coordinates fall from 60,446,096 to 7,761,983 bits and local-update indices
from 34,099,392 to 3,564,176 bits.  Grouping node constants once more by their
semantic `(opcode, arity, slot)` role and then selecting the shorter of that
role predictor and the topology-local predictor reduces the node-constant
term from 290,945,216 opened bits to 51,510,775 bits.  Only 26 bounded role
bases are retained; 2,568,432 cells are generated and 1,977,613 exact values,
including those bases, remain.  This hierarchy is compiler input to native
code selection, not a new parameter-row artifact.

Again, this is not a release-size claim or permission to publish another
parameter-row resource.  It proves that whole-row dedup and byte compression
were preserving tens of megabytes of reconstruction input.  The native
emitter must consume the selected functions directly, and the final word must
charge their framing, predictor code, exact support and values once.

Domain or value transforms are permitted only as fixed globally encoded
bijections.  Their program and inverse are charged in `code(p)`.  A transform
cannot obtain a shorter description by omitting its decoder.

## Logical functions in the artifact

### Direct dispatch

```text
dispatch(page generation, byte offset) -> transfer-class rank. (17)
```

A fixed 256 by `u32` tail is only the table candidate for (17).  Constant,
affine, run, rank/select, page-relative, and closed typed-SSA forms compete
under (15).  A resident implementation may expand the selected word into a
dense row once; those bytes are never released.

### Residual transition

```text
kernel(state rank, machine input)
    -> (event arm, RIP delta, output, dirty-patch program),
successor(state rank, event arm) -> next state rank.            (18)
```

State minimization occurs before encoding.  The compiler searches a total
successor function of state and event; only exact exceptions are ranked.  The
selected arm and RIP delta are output by the kernel.  They cannot also appear
in a serialized successor graph, and the same fields cannot reappear in a
derived Wasm projection.

### Topology and parameters

```text
instantiate(topology rank, instance rank, coordinate) -> value. (19)
```

Equal SSA topologies have one program.  Constants reconstructed by (19) are not
repeated in descriptors.  Structural coordinates, lifted constants, and code
proofs are separate columns and are quotiented before composition.

### Immutable memory

```text
memory(address) -> byte,    default 0.                          (20)
```

Zero pages and zero bytes have no support.  Equal extents share one value class
before compression or encryption.  Filesystem bytes already named by an
immutable Linux block extent are referenced rather than copied into boot RAM.
Genuinely unique content remains linear in its information.

### Resource incidence

```text
resource(physical coordinate) -> canonical object rank.        (21)
```

An object digest and extent occur once in the canonical object table.  Resource
references use object rank.  A resource index and delivery index cannot repeat
the same digest, extent, and offset tuple.

## Complete sharing normal form

Sharing is defined by observation, not by provenance, spelling, hash
collision assumptions, or a convenient chunk boundary.  For each retained
family `K`, let `D_K(x)` be the complete finite request domain of member `x`
and let `O_K(x,q)` be its exact response, including faults and boundaries:

```text
x ~=K y  iff  D_K(x) = D_K(y)
              and O_K(x,q) = O_K(y,q) for every q in D_K(x).   (21a)
```

This condition is necessary: a differing request is a concrete distinguisher.
It is sufficient: replacing either member by the same quotient rank preserves
every enclosing observation by substitution.  The publisher proves both
directions.  Reachability plus one distinguisher for every unequal pair proves
the lower bound; a total evaluator indexed only by the quotient rank proves
the upper bound.  Ranks are assigned by the canonical response/program order,
never by ELF, archive, path, address, page, discovery, or allocation order.

Semantic ranks remain typed.  After semantic canonicalization, all families
also enter one untyped immutable-payload quotient:

```text
payload(a) ~=bytes payload(b)
    iff length(a) = length(b) and byte(a,i) = byte(b,i) for every i. (21b)
```

Thus an instruction law is never confused with an archive member merely
because their bytes happen to match, while their identical immutable byte
extent is nevertheless stored once.  A canonical ELF read still reproduces
the exact optimized ELF bytes; semantic sharing occurs before emission and
byte sharing occurs after emission.

The six retained families have one necessary-and-sufficient ownership rule:

| family | complete distinguisher | one retained owner | reconstruction |
| --- | --- | --- | --- |
| block across ELF files | persistent output, ordered fault/barrier result and every future successor arm | one complete-future state class | minimally-wide component/successor fields in the single future table |
| pure slice topology | every typed live-input/parameter response, including trap | one total normalized SSA program | topology evaluator plus instance parameter generator |
| instruction meaning | every accepted decode-context/operand/state transfer, precise fault and next cut | one canonical transfer law | instruction-law evaluator or an explicitly retained conservative terminal |
| immutable/rodata substring | exact byte returned by every bounded read coordinate | exact extent owner plus selected byte-region program/residual | total program plus exact support/correction word |
| archive member | member byte read, symbol lookup, name/mode/order observation | one immutable member-payload rank plus observable view fields | deterministic GNU ar header, index, padding and payload generator |
| proof/coordinate/directory cell | exact cell at every declared coordinate after accepted roots are fixed | only an exception to the selected total generator | generator on complement, canonical exception rank on support |

The table is also an exact exclusion rule. For a fixed release closure, the
retained basis is

```text
B = {one evaluator per complete-future block class}
  + {one evaluator per extensional slice class and its irreducible bindings}
  + {one evaluator per terminal instruction-transfer class}
  + {one owner per distinct immutable byte string}
  + {one ARVM1 row per observable member and one ARVS1 row per symbol}
  + {one ordered-tree code, shared basename/inode/link material and sparse
     hardlink support for the canonical release namespace}
  + {one value per distinct, non-generated residual cell}.       (21b.a)
```

Nothing else is a basis element. In particular, an ELF-local block number,
slice node number, instruction spelling, payload provenance, archive-local
payload rank, member-header offset, file offset, prefix sum, digest copy,
Merkle path, directory node or delivery coordinate is forbidden whenever the
corresponding evaluator in (21b.a) reproduces it. This is stronger than
finding duplicate files: it removes the columns which name duplicates.

For each family the lower-bound witness and upper-bound constructor coincide:

```text
BLOCK        unequal finite future word / complete-future evaluator
SLICE        unequal typed input         / normalized SSA evaluator
INSTRUCTION  unequal context/state input / canonical transfer evaluator
BYTE STRING  unequal bounded read        / extent rank plus byte decoder
ARCHIVE      unequal member/symbol query / ARVM1+ARVS1+GNU-ar generator
RESIDUAL      coordinate where a != g    / g outside support, value inside
                                                               (21b.b)
```

Equality is therefore admitted only after the constructor proves the whole
request domain, while inequality is retained only with a concrete finite
distinguisher. A digest, sampled test, common source spelling or local
container rank proves neither implication.

They are not six optional compression passes.  Their product is the Artifact
normal form:

```text
NF = Future(Block(Control, SliceTopology, Parameters, TerminalMeaning))
   x ImmutableByteWord
   x ArchiveView(payload ranks)
   x Namespace(ordered tree, inode classes, payload ranks)
   x Residual(selected total generator).                     (21b.0)
```

Every edge in (21b.0) points from a consumer to a canonical rank; no child
owns its parent's spelling and no parent owns another copy of its child.  A
putative smaller representation must therefore do one of three things: merge
two distinguishable responses, omit a reachable coordinate, or give a shorter
program in the declared generator/factor grammar.  The first two have direct
finite counterexamples.  The third is admitted only when its fully charged
program plus residual beats the incumbent and still reopens the whole domain.
This is the necessary-and-sufficient target for complete sharing; a set of
container-local deduplication ratios is not.

Necessity is uniform: changing a class above supplies the request in column
two as a finite counterexample.  Sufficiency is also uniform: the evaluator
in column four is total on the declared domain and depends only on the shared
rank and explicit bindings.  Provenance, pathname, ELF identity, link
address, allocation order and delivery placement cannot create an owner.

Let `U_K` be the declared occurrence population of family `K`.  Publication
records `|U_K|` independently of the supplied array and requires exact
equality for every enabled family.  `|U_K| = 0` is a valid complete result:
the enabled bit proves that the total generator and empty closure were
checked, without inventing an undistinguishable sentinel row. It similarly fixes the immutable-owner
and generated-cell populations.  Therefore dropping a second slice while
leaving one slice present, shortening the payload list, or truncating the
proof-coordinate domain cannot turn an incomplete projection green.  Once
all semantic classes are selected, their stored byte extents join every ELF,
rodata and archive extent in the single byte quotient (21b); container-local
quotients are not publication results.

Cardinality is necessary but not sufficient to bind these populations.  The
complete gate additionally requires the following exact correspondences:

```text
BLOCK observation       <-> one state in the complete ELF-union machine,
SLICE observations      <-> topology(state) followed by parameters(state),
INSTRUCTION response    <-> one member of the total block-offset partition,
IMMUTABLE_READ response <-> one exact payload occurrence,
ARCHIVE_MEMBER response <-> one member `(name, mode, exact payload)` or
                            symbol `(name, member rank)` view,
DERIVED_CELL response   <-> one actual != generated exception coordinate.
                                                                    (21b.1)
```

The archive count and flattened member count are independently declared by the
release closure.  The complete gate invokes the archive generator itself and
compares the entire generated GNU ar stream with the canonical input.  Thus a
correct family mask plus a wrong member binding, a missing archive, or one
changed archive byte is red in the same composition; an adjacent archive test
cannot lend its green result to an incomplete release.

The flattened member coordinate is the binding. If `b` is the declared base
of the archive-member interval, member `i` uses payload occurrence `b+i`.
Canonical payload ranking is then regenerated by the global rank map. A stored
member-to-payload-rank column would both duplicate that total function and
become stale when an unrelated payload is inserted, so it is rejected as a
second route.

### Executable blocks across ELFs

The request to a block is an accepted live architectural input together with
the permitted event suffix.  The response is the exact persistent-state
projection, ordered fault/barrier result, and complete-future successor rank:

```text
block(r, e*) -> (persistent output, fault/barrier trace, future rank). (21c)
```

The fixed CPU profile, machine ABI, memory-order contract, privilege mode and
precise-fault cut are part of the domain.  RIP, symbol names, source object and
link address are parameters, not identities, when substitution proves that
they only feed declared bindings.  Equality of decoded mnemonics, source bytes
or one test vector is neither necessary nor sufficient.

For each class the post-link compiler independently minimizes work and span
after rebinding direct and RIP-relative fields. Publication requires one body
to attain both minima; byte length and lexicographic bytes select only inside
that exact physical fiber. Hence equal block functions emit the same body;
binding values live in the enclosing ELF projection. The Artifact stores
neither a second block graph nor one body occurrence per ELF.

The construction gate forms one disjoint-union Moore machine from every
linked ELF.  It does not retain the former `X86B1` row, because that row
repeated the normalized plan already present in the slice population.  The
post-link compiler now exposes four independent transient columns from the
same compile call:

```text
C(s) = rank(X86C1 control shell)
T(s) = rank(SSTP1 pure-slice topology)
P(s) = rank(SSPR1 lifted parameters)
I(s) = rank(canonical terminal instruction law), or bottom.    (21c.1)
```

`X86C1` contains only control/fault/barrier shape, terminal operand selectors
and external successor bindings.  It contains no plan or instruction byte
stream.  The immediate refinement seed is the fixed 16-byte tuple
`(C(s),T(s),P(s),I(s))`; each closed successor becomes a state coordinate in
the union.  Partition refinement is run once over the union, not once per ELF:

```text
P0(s) = rank(C(s), T(s), P(s), I(s))
P*(s) = fixpoint rank(P0(s), P*(succ(s,0)), P*(succ(s,1))).    (21c.2)
```

After the fixed point, the sole BLOCK response is
`(C(s),T(s),P(s),I(s),P*(succ(s,0)),P*(succ(s,1)))`. The weaker 16-byte seed
is not exposed as a parallel semantic identity. Therefore a changed future
arm splits the BLOCK family itself, rather than only an adjacent report.

That tuple is a semantic equation, not a fixed-width stored row. Let `n_j` be
the domain size of field `j`. The canonical physical row uses exactly
`ceil(log2 n_j)` bits for that field, with zero bits for a singleton domain;
the terminal field has one additional value for bottom. Every class row is
concatenated as minimally-wide field columns over future-class order into one
virtual Byte* table, and only the
last byte has canonical zero padding. Thus there is one table payload, not one
24-byte `u32` tuple payload per future class. Direct bit lookup reconstructs
all component and successor ranks and is checked against the fixed point.

Thus two image-local graphs with the same complete future have one state
class. A changed arm is a finite distinguishing word and must split both its
source and every distinguishable predecessor. The common refinement lives in
`support/future`; `postlink-compiler` and the release Artifact call the same C
implementation.  Exact component ranking proves both implications: equal
tuples reconstruct equal immediate observations, while an unequal component
is a concrete immediate distinguisher.  Local observation ranks, local future
ranks, ELF names and addresses are transient construction columns.

### Pure slice topologies

A topology request supplies every typed live input and every lifted parameter.
Its response is the complete ordered result tuple or trap:

```text
slice(live inputs, parameters) -> (live outputs, trap).         (21d)
```

Alpha-renaming nodes, sorting commutative arguments, deleting dead nodes and
lifting literals are only preprocessing.  Two resulting DAGs share a topology
rank exactly when (21d) is equal on the full finite domain.  The proof either
reduces both to the same total canonical program or returns a concrete input
that distinguishes them.  A parameter column which is a total function of
topology and instance rank is generated and has no stored occurrence.

The transient `SSTP1` spelling contains only stack-input arity, node
opcodes/arities, operand tags, retained node/projection edges, output shape and
local extent. Function/start/end, source instruction count, node names,
dependency-wave materialization, lifted constants and frame coordinates are
absent. `SSPR1` contains exactly the lifted values and changed-local
coordinates needed to reconstruct the normalized plan. Consequently a
parameter change cannot split a topology, while a changed opcode or edge must
split it. `SSTP1`/`SSPR1` are build observations, not published sidecars.

The published program material is smaller still. Control, topology, parameter
and stabilized-future representatives exist only inside the construction
gate. The gate reopens them to prove complete-future equivalence and then
discards them. The independently runnable optimized ELF fragments are the
sole executable payload owner. Consequently the published word contains no
instruction-proof cell, residual-state row, residual-edge row, topology
dictionary or parameter stream. The release report requires
`stored_normal_instruction_bytes=0`; a semantic report beside a second program
copy is red.

### Instruction meaning

An instruction class is the total symbolic transfer under a fixed decode
context:

```text
instruction(context, operands, input state)
    -> (output state, precise fault, next cut).                 (21e)
```

Context includes mode, operand/address widths, feature bits and relevant
privilege assumptions.  Mnemonic, opcode bytes and operand spelling are not
the class key.  Conversely, equal arithmetic with different fault ordering or
memory atomicity cannot share.  Block and slice construction refer to one
instruction-meaning rank, so the semantic law is not serialized again in
every topology or ELF.

`X86I1` is the canonical transient instruction-law spelling.  The compiler
lowers exactly one instruction through the same physical SSA normalization as
a full block, closes its direct successor coordinates as bindings, and keeps
only `X86C1 + SSTP1`.  `SSPR1` values are instruction-instance parameters, not
law identity.  Consequently `90` and `66 90` both become one identity law,
while `xor eax,eax` remains distinct; the regression proves both directions.
Every source instruction is required exactly once by the block-offset
partition.  After composition, all nonterminal instruction classes are erased;
the normalized `(X86C1,SSTP1,SSPR1)` block response is their sufficient result.

Only an anonymous barrier which the typed semantic grammar cannot lower uses
the conservative decoder spelling `X86T1`; it is explicitly named by a
terminal block and remains visible in the report.  `X86T1` drops RIP and
structure padding but retains source spelling, so it is deliberately not
presented as the extensional lower bound.  Publication cannot hide such a row
inside an ordinary instruction class.

### Ordinary ELF reconstruction

Semantic sharing must remove owners from the final ELF population, not merely
produce a report beside a second complete ELF payload.  After relocation and
proof sealing, the compiler exposes each dense block state's exact file span.
For image `j`, those spans form one contiguous compact-code interval:

```text
ELF(j) = prefix(j)
       || product(s in states(j)) emitted(j,s)
       || suffix(j),                                             (21e.1)

file_offset(j,s) = |prefix(j)|
                 + sum(t preceding s) |emitted(j,t)|.            (21e.2)
```

An erased block has extent zero and no payload occurrence.  Equation (21e.2)
generates every per-state file coordinate, so retaining that coordinate column
is forbidden.  Prefix, nonempty emitted spans and suffix enter the same global
immutable-payload quotient.  Reconstruction substitutes each occurrence's
representative and compares the complete ordinary ELF byte-for-byte.  A gap,
overlap, reordered state, changed relocated byte or missing empty state is a
publication error.

This split is necessary because any differing final byte distinguishes an ELF
read.  It is sufficient because concatenation in (21e.1) reconstructs every
read coordinate.  It does not yet prove that the occurrence-to-payload-rank
function has its shortest generator; that column still passes through the
general finite-function selection before publication.

### Immutable and read-only substrings

The observable request is an exact bounded read.  When the prior-factor member
of the byte-region program grammar is evaluated, its candidate universe is
every substring of every accepted canonical immutable extent, not only pages,
files, compressor windows or content-defined chunks:

```text
read(object rank, offset, length) -> exact bytes.               (21f)
```

A fixed self-delimiting subgrammar contains literals, prior-factor references,
concatenation and repetition.  Its evaluator searches all factor candidates
and selects the globally shortest complete derivation *inside that
subgrammar*, with global program rank as the tie break.  Heuristic parsing may
provide an incumbent but cannot certify the result.  The outer (7l) selection
then compares that derivation with structural and closed-form programs; a
factor win alone is not the byte-region normal form.

Complete sharing does not mean replacing every repeated one-byte substring by
a larger reference.  It means no repeated factor whose reference and framing
have strictly lower charged bits remains literal.  A duplicate retained
despite positive net saving is a publication error.  Zero runs, ELF padding,
read-only filesystem extents, rodata, archive payloads, proof strings and
other immutable bytes all compete in this single factor population.

Selection alone is not a storage result.  The stored spelling is exactly

```text
literal   = 0 || byte8
reference = 1 || length[W] || prior-coordinate[W]
W         = ceil(log2(|W| + 1)).                               (21f.1)
```

The writer receives a virtual Byte* view and the selected parse.  The view is
only `(immutable payload owners, representative ranks, strict CSR ends)`; an
opened canonical word is never allocated.  Literal emission reads its owner
directly.  Publication parses the packed bits and compares every literal and
referenced interval against the same view, so it also allocates no N-byte
decode target.  It rejects truncation, trailing bits, nonzero byte padding,
zero-length references and a source which is not strictly prior; overlapping
copies are the only permitted recurrence.  The packed bit count must equal
the exact dynamic-program cost, otherwise publication is red.

Construction memory is not part of the stored result, but an `O(N)` bound is
not sufficient: its physical coefficient is part of the publication
contract.  The sole input identity remains the virtual byte view

```text
(immutable payload owners, representative ranks, strict CSR ends).
```

Neither the concatenated byte word nor a word-sized coordinate column is a
second authority.  The construction therefore uses a compact complete-future
quotient of the byte alphabet.  Its primary sequence has one byte state per
canonical byte; rank/select, interval topology and sampled coordinates are
packed bit columns.  The quotient answers exactly the two observations the
factor grammar needs:

```text
longest_prior(target) -> maximum length,
first_source(target, length) -> least prior coordinate.       (21f.2)
```

An implementation may use BWT/FM, a compressed suffix tree or a run-compressed
equivalent, but it may not expose SA, ISA, LCP and LPF as four simultaneous
`u32[N]` owners.  For the fixed byte alphabet, compact LZ construction has an
`N log2(256)`-bit primary bound.  Thus the physical target is one `N`-byte
sequence plus packed cut/index redundancy, rather than sixteen bytes of
coordinates per input byte.  Every auxiliary bit must name a query or update
used by (21f.2); a dense coordinate column with no such independent observer
is red.

The shortest-spelling dynamic program does not justify another dense owner.
Suffix costs are monotone and removing one leading byte changes the optimum by
only 0..9 bits.  Store those differences as nibbles in the *final factor-code
allocation*, beginning at its high end.  The code writer advances from the low
end.  At source coordinate `i`, even the all-literal prefix occupies at most
`9i/8` bytes, while the first unread nibble is at least

```text
9N/8 - N/2 + i/2 = 5N/8 + i/2.
```

Consequently

```text
9i/8 < 5N/8 + i/2  <=>  i < N,                              (21f.3)
```

so output cannot overwrite an unread cost difference.  Sparse block-end
costs, token starts and canonical sources occupy cut cells and are consumed as
soon as their final token is written.  No dense `source[N]`, `length[N]` or
decoded target survives.  The published bytes are written once, directly from
the virtual view through (21f.2), and verified against that same authority.

The former suffix-array construction required
`16(N+1) + 8B + 8 ceil(B/2) <= 16.75N + 32` bytes for
`B=ceil(N/16)`.  That number is retained only as the measured red baseline;
it is not an accepted normal form.  Publication reports construction peak,
primary quotient bytes, packed-index bits and final factor bytes separately so
that final storage and construction memory cannot be conflated.

The current migration gate invokes the suffix-index baseline exactly once.
Before the call it reserves only the subgrammar's all-literal upper bound,
`ceil(9N/8)` bytes, for the result. It selects the factors, writes the packed
buffer, verifies it against immutable owners without a source word, and
reports its exact used bit extent. Running one preliminary projection merely
to learn the output length and then repeating it is forbidden. Publication
remains red until this baseline is a candidate inside (7l), rather than a
mandatory word after every other generator.

### Archive members

An archive is a generated ordered view, not an independently stored copy:

```text
archive member read -> immutable payload rank,
archive symbol lookup -> ordered member rank,
archive byte read -> deterministic header/index/payload generator. (21g)
```

Member payload equality is (21b).  Member name, mode and order remain archive
view fields only when observable; normalized timestamp, uid/gid, padding,
extended-name table and symbol index are total functions of the declared
member sequence and therefore generated.  Equal members across different
archives have one payload rank.  The final generated stream must reproduce
the canonical `.a` byte-for-byte, but those bytes are not stored beside its
members.

The C gate now performs that last implication rather than checking only the
member ranks.  `artifact_archive_complete_project` computes the global payload
quotient once, verifies every archive member against its exact occurrence and
rank, regenerates the complete GNU ar stream into separate workspace, and
compares every generated byte with the canonical input.  A one-byte change in
the claimed stream is red.  On success the entire opened archive stream is
reported as generated, not as another immutable owner.

The inverse boundary is equally strict. `artifact_archive_read_measure`
counts the finite member and symbol populations before allocation, and
`artifact_archive_read` returns a view whose names, symbol names and payloads
borrow the canonical input bytes. Member header coordinates form a strictly
increasing construction column. GNU symbol offsets are resolved against that
column by binary search, so opening `S` symbols and `M` members costs
`O(M + S log M)` rather than hiding an `O(S*M)` term. Re-emitting the returned
view must reproduce the source byte-for-byte. A symbol offset that is not one
of the measured member headers is a concrete red.

The only stored view spellings are

```text
ARVM1 || name-length || name || mode
ARVS1 || name-length || name || member-ordinal.                 (21g.1)
```

Member payload bytes are deliberately absent from `ARVM1`; the flattened
member coordinate resolves them through the global immutable population.
Timestamps, uid/gid fields, decimal header spelling, long-name offsets,
symbol-table offsets, alignment and padding are generated. The complete
semantic response still contains the exact member payload, because a changed
payload is an observable archive-member difference even though that payload
has only one physical owner.

The production root audit uses that reader for every archive inode. Its v3
report separates member occurrences, symbol occurrences, opened member bytes,
unique member-payload bytes, duplicate member-payload bytes and generated
archive-stream bytes. Exact extent bytes, not a digest, decide member payload
identity. The fixed regression places the same two object members in two
archives and requires four occurrences, two owners and a byte-for-byte
regenerated stream. This closes archive discovery and exact duplicate
ownership, but it is still an upper-bound audit: the final release publisher
must concatenate those two owners with ELF/VFS owners before the global
substring factor pass.

### Proofs, coordinates and directories

These populations form a dependency DAG.  A cell is retained only when it is
not a total function of earlier accepted roots:

```text
optimized ELF + linked-input identity -> proof,
extent lengths + canonical ranks       -> coordinates/rank-select,
object ranks + key intervals           -> directory decision DAG. (21h)
```

The irreducible roots are the accepted source identity, canonical program
word, authentication root and exact exceptions not generated by a shorter
total law.  Proof scalars, cumulative offsets, endpoints, extents, repeated
digests, page numbers, child counts and delivery locations are regenerated
when (21h) determines them.  Directory lookup is the minimum total decision
DAG over the declared key domain; a digest and extent are owned only by the
object table, while a directory edge names its canonical object rank.

For the canonical directory, deterministic leaf and branch writers are the
total generator.  Nodes are content-address candidates but equality is still
proved by full node bytes.  Rebuilding the same 300-row directory adds zero
nodes; changing one row adds exactly its leaf and root (two nodes), while the
two unaffected leaf subtrees retain their identities.  This is the concrete
`O(log N)` update witness for that fixture, rather than a promise that a flat
directory will later compress well.

Let `A : C -> Byte*` be the independently opened cells and let every admitted
generator `g` be total on exactly the same declared coordinate set `C`. For a
fixed `g`, its necessary residual is uniquely

```text
support(g) = { c in C | A(c) != g(c) },
value(c)   = A(c), c in support(g).                             (21h.1)
```

Removing a support coordinate changes the public answer there; retaining a
coordinate outside the support stores a value already implied by the roots.
Equal residual values share one payload class, and the support/rank function
is itself reopened from its minimum finite decision DAG. Candidate generators
are compared only after charging generator identity, support program, residual
rank program and unique residual payload bytes. Choosing a generator because
it has fewer mismatches, without charging those four terms, is not the normal
form.

For a release namespace, storing sorted complete path strings is not a normal
form: a depth-`d` leaf repeats every ancestor and can make path bytes
quadratic. Instead order nodes by component-wise depth-first preorder. Let
`P` include the root. The root name and its outer parentheses are implicit;
each other node contributes one open and one close bit. Thus the complete
ordered-tree shape is a canonical balanced-parentheses word of exactly
`2P-2` bits. Its information lower bound is
`ceil(log2 Catalan(P-1))`; the direct code differs only by `O(log P)` bits and
can build succinct rank/select indexes without retaining a dense parent
column.

Only the basename of each non-root node is then an input byte occurrence.
Repeated basenames enter the same global exact-byte quotient and factor word
as rodata and archive names. Inodes are numbered by first path occurrence.
Therefore a non-hardlink path generates the next inode ordinal, while the
necessary support is exactly

```text
H = { p in [0,P) | inode(p) was introduced before p }.          (21h.2)
```

For `p` outside `H`, `inode(p) = p-rank_H(p)`. For `p` in `H`, the retained
value is its earlier inode ordinal. Removing one member of `H` changes inode
identity at that path; retaining a row outside `H` duplicates the formula.
Directory aliases are rejected. Regular-file content ordinals are the number
of preceding first-occurrence inodes of the same nonempty content family;
empty files use the zero content class. File type comes from the normalized
inode kind, so `mode` retains only permission/special bits. Size comes from the
selected payload extent. Full paths, file-type mode bits, dense content ranks,
parent ordinals, subtree ends and readdir rows are absent.

The remaining inode basis is precisely observable mode/uid/gid, device id for
character/block devices, symlink target, sorted xattrs and the content-family
choice. From balanced parentheses, basenames and sparse `H`, a source-free
reader regenerates parent, lookup, readdir and path-to-inode results. The C red
suite changes tree order, removes a parent, changes a generated content
ordinal, repeats a directory inode, adds a redundant file-type mode bit,
reorders xattrs, corrupts topology padding and corrupts an alias row. Every
case rejects. The composition gate also requires every emitted namespace row
to resolve through the sole global immutable-byte population; a directory
sidecar is not another owner.

Authenticated node fanout, branch bounds, node digests, proof paths and
root-to-leaf delivery coordinates are total functions of this namespace and
the fixed node writer. Consequently they are regenerated, not entered again
as immutable payload owners. A directory implementation is complete only when
every accepted lookup and enumeration reopens from this basis and changing one
irreducible member changes exactly the affected authenticated path.

The fixed `development-standard-v1` root provides the first production
namespace measurement. Its 6,210 paths and 4,860 inodes open 188,821 bytes of
complete path spelling. Component preorder retains 55,498 basename bytes and
12,418 topology bits; 1,350 hardlink aliases are the only path-to-inode
exceptions. Inode/link/topology material opens as 207,254 bytes, the exact
global-byte quotient reduces it to 72,889 bytes, and the prior-factor grammar
stores the standalone namespace in 446,441 bits (55,806 bytes), with zero
factor gap. This is a conservative standalone upper bound: joining the same
material with ELF, rodata and archive bytes can only add cross-family sharing.
Construction workspace is reported separately as 2,624,016 bytes and is not
counted as stored distribution data.

### Mechanical publication reds

The six families above are rejected when any of these witnesses exists:

* two members with equal complete observations have different semantic ranks;
* two members with different complete observations share a semantic rank;
* one linked ELF is absent from the global block-state union, or its state to
  semantic-observation map is not a strict complete bijection;
* a component-local optimized ELF is supplied in place of its relocation-
  bearing linked input; consumed relocations make the release-wide semantic
  union unprovable, so an optimized output cannot re-enter the compiler;
* a byte factor with positive net reference saving remains duplicated;
* an archive stores a member stream already named by its payload rank;
* a proof, coordinate or directory cell is retained although (21h) generates
  it from already accepted roots;
* a semantic rank depends on an address, file, page, path, discovery order or
  delivery placement;
* decoding does not reproduce every canonical ELF/archive/VFS byte and every
  typed machine observation exactly.

The release report lists, for each family, opened members, reachable members,
quotient classes, generated cells, exact exceptions, retained bits, the
matching lower bound and any unresolved program-length gap.  A compressed byte
count without these terms is not evidence of complete sharing.

The C composition gate requires the exact populations enabled by its declared
mask, the exact declared occurrence count of each population, the complete block-state union,
exact immutable payload ownership, generated archive views, generated-cell
residuals and a gap-free factor decode from stored bits alone. Its binding
reds alter an immutable response, an archive member rank, a derived exception,
one claimed canonical archive byte and the authoritative compiler topology
independently. `artifact_program_project` runs inside that gate; it
additionally
requires a contiguous instruction-offset partition for every state, factors
the immediate seed through the four component ranks above, erases nonterminal
instruction witnesses, runs the global future fixed point and exposes only
the stabilized component-plus-successor response.
The real-ELF integration check sends two 57-state compilations through this
single observer path and then through the same composition gate. The 114
image-local states become 47 global future classes and 20,228 opened component
bytes become 2,644 unique component bytes. Their former 47 fixed 24-byte rows
would occupy 1,128 bytes; the six current minimally-wide field columns occupy
1,504 bits, or 188 bytes in total. The same transaction commits two distinct
final optimized ELFs:
27,360 opened bytes become 22,984 unique fragment bytes, and 2,832 bytes of
retained program material produce a 25,816-byte canonical word and a
28,128-bit stored prior-factor spelling. Both ELFs and every retained program
representative decode with no source-word input and a zero gap.
That executable-only core has mask `0x0f`. The version-9 production stage adds
the canonical root namespace, enables the independently checked empty archive
and residual families, and reaches `0x3f`: on the two-ELF fixture its canonical
word is 25,898 bytes and its stored spelling is 28,592 bits. The distribution
wrapper additionally exercises nonempty archive, ordinary-payload, hardlink
and namespace populations in one process. Publication remains red only until
the fixed builder runs that already-connected stage over the complete root and
projects its resulting word through Storage; a fixture green is still not a
distribution-size claim.

The fixed binutils package checkpoint supplies the first large-population
measurement of this representation. Its 1,928,805 future classes require a
98-bit logical response (`12 + 13 + 19 + 12 + 2*21` bits). Replacing fixed
24-byte tuples with the minimally-wide table changes canonical program
storage from 59,022,753 to 36,359,295 bytes. Merely laying those same bits out
as six complete coordinate columns instead of interleaved rows leaves the
50,788,421-byte canonical word unchanged, but exposes equal runs to the exact
outer quotient and reduces its stored spelling from 257,873,452 to
234,257,530 bits (32,234,182 to 29,282,192 bytes). This is an observed 9.16%
factor reduction. Canonically renumbering the already-minimal future classes
by their complete response row then reduces the same spelling to 171,966,144
bits (21,495,768 bytes): 26.59% below column layout alone and 40.04% below the
old 35,850,722-byte fixed-tuple spelling. All 1,928,805 class coordinates move
under that bijection; state uses and successor ranks are rewritten together.
These measurements have identical optimized ELFs and semantics and are not a
Deflate setting or an omitted payload.

### Necessary-and-sufficient construction

The implementation uses two quotients and one program selection in this
order; none may stand in for another:

```text
typed complete observation --(21a)--> semantic rank
canonical emitted bytes     --(21b)--> payload rank
payload ranks + extents      ----------> virtual byte-region function
virtual byte-region function --(7l)--> one selected program word. (21i)
```

For blocks, slices and instructions, an unequal total response supplies a
request coordinate and therefore a lower-bound distinguisher.  An equal total
response supplies one evaluator indexed only by the shared rank and therefore
an upper bound.  This proves the two implications of (21a), rather than
inferring them from a digest or source spelling.  Cross-ELF sharing follows
because ELF identity and link address do not occur in that evaluator; every
surviving address-dependent value is an explicit binding parameter.

For immutable extents, exact byte equality first deletes complete duplicate
owners.  Let `p_0 .. p_(M-1)` be the resulting payload ranks and let

```text
W(r,o) = payload_(p_r)[o].                                    (21j)
```

The extent function and strict CSR ends regenerate every object interval in
`W`; no concatenated owner is opened.  Selection (7l) ranges over every
coordinate of this region function, so rodata in one ELF, an archive member
and a filesystem extent are not separated by page, file or compressor
windows.  Prior-factor references compete with structural and closed-form
programs inside the same fully charged search.  The bounded oracle enumerates
all factor choices when that candidate is tested, but the outer publisher must
also prove that no shorter admitted generator/residual word remains and close
its lower-bound gap on the full region.

For every reconstructible family, fix a candidate total generator `g` over
the already accepted roots and define

```text
R_g = { i in [0,N) : actual(i) != g(i) }.                       (21k)
decode(i) = i in R_g ? exception(rank(i)) : g(i).               (21l)
```

This support is necessary: deleting any member of `R_g` changes the response
at that coordinate.  It is sufficient: substitution in (21l) reconstructs
all `N` cells.  A coordinate outside `R_g` is therefore forbidden storage,
while equal exception values have one payload rank.  Proof scalars, prefix
coordinates and directory decisions are merely three instances of the same
law.  Finally the publisher compares all candidate generators in the fixed
grammar by their fully charged `(program, support, exception)` length; only
this outer selection justifies calling the remaining residual irreducible.

### Single ownership theorem

Let `Obs` contain every public read of an optimized ELF, archive, filesystem
object and proof, and every accepted typed execution request.  A retained
population is a complete-sharing normal form exactly when all of the following
hold:

1. every reachable typed request factors through exactly one class of (21a);
2. every immutable byte coordinate is owned by exactly one representative of
   (21b); the selected byte-region program refers to that virtual coordinate
   and never owns a second copy;
3. every archive byte is a total function of its observable view and payload
   ranks, never a second owner of a member payload;
4. every proof, coordinate and directory cell satisfies (21l), and the stored
   support is exactly `R_g` for the selected fully charged generator;
5. every public observation is reproduced, and every retained bit has a
   distinguisher or belongs to the shortest program in the declared grammar.

Necessity is pointwise.  Violating item 1 has either a split equal function or
a merged distinguishable request.  Violating item 2 or 3 gives two owners for
one immutable observation.  Violating item 4 either stores a determined cell
or loses an exception coordinate.  Violating item 5 gives a retained bit with
no observable purpose or an incorrect decode.

Sufficiency follows by substitution in dependency order:

```text
instruction laws
      -> pure slice topologies
      -> complete block futures
      -> canonical optimized ELF bytes
      -> payload owners and one global virtual Byte* view
      -> generated archive/layout/proof/directory views
      -> public reads and execution observations.              (21m)
```

At each arrow, the consumer refers only to the canonical rank and explicit
binding parameters of the preceding stage.  Induction over this DAG therefore
reproduces `Obs` without retaining a second representation.  The ownership
rule is concrete:

| population | sole retained owner | forbidden second owner |
| --- | --- | --- |
| instruction meaning | typed transfer rank | opcode/mnemonic copy per block |
| pure slice topology | total topology evaluator | DAG copy per instance |
| equivalent blocks across ELFs | complete-future block rank plus bindings | body/graph per ELF |
| rodata and other immutable bytes | payload representative plus selected byte-region program/residual | opened word or file/page/container-local copy |
| archive member payload | payload rank | serialized member bytes beside the view |
| proof/coordinate/directory cell | selected generator or exact residual | generated dense cell/table |

This theorem does not claim uncomputable Kolmogorov minimality.  It proves
single ownership for the complete declared observation domain, and shortest
spelling inside the explicitly charged generator and factor grammars.

### C implementation checkpoint

The Artifact library now expresses the common identity operation directly.
`artifact_share_project` consumes a typed canonical domain and its complete
finite response word, orders observations independently of occurrence order,
compares equal-digest candidates byte-for-byte, and emits one dense canonical
rank.  `artifact_share_verify` reconstructs that quotient and rejects both
directions of an invalid claim.  Its regression covers all six families,
family separation, permutation invariance, equal observations split between
two ranks, and unequal observations merged into one rank.  The digest is only
an `O(32N)` ordering accelerator; it is never the equality witness.

The generated projections are also executable C rather than prose:

* cumulative object coordinates, endpoints and rank-select are recomputed from
  the one extent column, with zero retained prefix cells;
* a canonical GNU archive stream, including its member headers, long-name
  table, symbol index, padding and member offsets, is generated from the
  ordered view and shared payload ranks; the complete regression regenerates
  every byte into non-aliasing workspace, rejects one changed canonical byte,
  is opened by the system `ar` reader, and independently recomputes the global payload quotient
  to reject either distinct ranks for equal members or one rank for unequal
  members;
* the declared literal/prior-factor grammar has an exact bounded dynamic-
  programming oracle over every prior substring.  The 53-byte regression falls
  from 477 literal bits to 250 bits with an unresolved gap of zero and decodes
  byte-for-byte.

Two cross-container gates are now executable as well.  `artifact_payload`
puts canonical ELF extents, rodata, archive members and proof strings into one
untyped exact-byte quotient after their typed semantic ranks have been chosen.
The regression removes an entire duplicate extent, concatenates only the four
canonical owners, and then finds 38 further bytes through the all-substring
oracle.  Container provenance never enters either rank.

`artifact_derive` compares every opened proof, coordinate or directory cell
with its selected total generator.  Equality deletes the cell; inequality
creates one support coordinate, and equal exception values share one rank.
Its regression reconstructs all six cells exactly from three generated cells
and two values for three exceptions.  `artifact_rank_map` supplies the missing
finite-function projection for construction ranks: it pads an arbitrary
occurrence domain with one distinct absent response, builds the minimum ordered
residual DAG, deletes the dense rank column and reopens every real coordinate.
The seven-coordinate regression retains 12 of 14 possible child cells; the
complete composition also reopens both semantic and payload ranks even when a
small population has no profitable residual-node sharing.

The composition input names the exact nonempty semantic-family mask proved by
the enclosing closure walk.  The implementation rejects an unknown bit and
rejects a supplied observation population whose observed mask differs from
that declaration.  Consequently a publisher cannot obtain a complete green by
silently omitting blocks, slices, instruction meanings, immutable reads,
archive members, or derived cells that its closure proof declared nonempty.

The bounded dynamic program is deliberately an oracle, not a Linux size claim.
Its complete search is quadratic and therefore cannot be the full-release
writer.  The suffix-index implementation now returns the same cost, token
lengths and canonical sources on all 2,046 binary words through length ten and
512 random words, with `unresolved_bit_gap=0`; its source selection uses LCP
intervals rather than rescanning long factors.  `artifact_complete_project`
additionally enforces the only legal composition order, rejects the untyped
payload family at the semantic boundary, and reopens every semantic rank,
derived cell and canonical byte.  Until the post-link build supplies complete
block/slice/instruction observations and this writer consumes the complete
release population, the canonical release-word gate remains red.

### Fixed-recipe release population before complete sharing

The retained `development-standard-v1` candidate-root checkpoint has 5,827
regular paths, 4,477 regular inodes, and 238,711,344 inode payload bytes.
Re-running the independent C population audit with extent-and-exact-byte
equality, rather than digest equality, gives this strict 4 KiB-page upper
bound:

| opened population | input bytes | exact nonzero page-owner bytes |
| --- | ---: | ---: |
| linked ELF | 173,524,048 | 171,291,056 |
| archive | 32,839,130 | 32,703,906 |
| other immutable files | 32,348,166 | 32,323,552 |
| all classes | 238,711,344 | 236,318,514 |

Only 307,208 zero bytes and 2,085,622 duplicate nonzero page bytes disappear at
that boundary. It is therefore a deliberately red upper bound, not the target
format. Within ELF input, 117,052,125 bytes are executable `PT_LOAD`,
45,524,512 are read-only `PT_LOAD`, 9,102,768 are writable `PT_LOAD`, and
1,844,643 are non-load bytes. The next publisher must attack these populations
in that order: semantic block/slice/instruction ownership inside executable
bytes, the global immutable substring word across read-only/archive/other
bytes, then generated proof/coordinate/directory cells. Whole-page equality
cannot reach the 75 MiB release target because its proved upper bound is still
236,318,514 bytes.

The same audit opens 31 archives as 4,240 member occurrences and 18,057
symbol occurrences. Their members contain 32,065,088 bytes, of which
31,784,616 are exact whole-member owners and only 280,472 are duplicate
whole-member bytes. Twenty-two streams in this older checkpoint have valid
but noncanonical GNU symbol-table padding; the v4 audit reports them as
rewrite inputs instead of confusing input normalization with publication.
The current recipe normalizes them before its final gate and requires
`archive.rewritten_streams=0` there.

As a bounded production measurement, all 31 normalized archives plus the
two-ELF semantic anchor form a 32,536,501-byte canonical word. The exact
prior-factor grammar stores it in 104,850,165 bits (13,106,271 bytes), with a
zero gap: 59.7% of the canonical bytes disappear even though whole-member
equality removed less than one percent. This is not yet the full release
number because ordinary inode and complete ELF populations must be composed in
the same word. The measurement originally required 1,561,752,064 construction
bytes. Aliasing the dead radix `count[N+1]` storage with `next_rank[N]` first
reduced the same construction to 1,431,606,060 bytes. Reusing the disjoint
LCP/source RMQ and suffix-cost lifetimes now reduces it again to exactly
1,171,314,048 bytes (`36N+12`); oracle parity proves that no selected token or
stored bit changed in either substitution.

## Exact meaning of minimum

No computable compressor proves Kolmogorov minimality for every program.  A
rigorous claim names its search space and lower bound.  This design makes five
exact claims:

1. a total closure witness proves an upper bound before any population is
   materialized;
2. reachability and complete-future distinction prove the matching lower
   bound and therefore the exact `N`;
3. a total generator and exact coverage prove every rank below `N` is used and
   no value lives outside it;
4. ranks (12) and (13) meet the information lower bound for the selected
   support and multiplicity class, up to self-delimiting counts;
5. the compiler enumerates the fixed canonical predictor grammar below the
   incumbent length and selects the minimum complete code by (15).

If every shorter program is eliminated by an exact semantic counterexample or
a lower bound above the incumbent, the build certificate proves no shorter
program exists in that grammar.  Without that certificate, the report includes
the unresolved bit gap and must not claim global incompressibility.

## Identity coordinates

These identities are deliberately separate:

| identity | sufficient coordinates |
| --- | --- |
| linked program | executable bytes, load map, relocation/patch generation |
| decode context | RIP, machine mode, operand/address size, required features |
| code proof | page generation and exact relative byte extents |
| transfer class | normalized persistent-state projection and barrier result |
| dispatch class | transfer class, normalized predicate, successor classes |
| canonical object | exact semantic bytes and extent |
| delivery | shard and pack placement; never part of semantic identity |

CR3 and physical page coordinates can prove a mapping but do not belong in a
reusable arithmetic transfer.  CPL, paging mode, CS mode, and feature
assumptions cannot be dropped merely because two byte strings match.

### Identity is not publisher authority

A digest fixes which bytes are requested, not who may publish them. An ELF
proof binds an output to its declared linked input, not that input's origin.
Package signatures, Artifact commitments, delivery pins and workspace AEAD
are distinct checks, never alternatives around one another.

Authenticate the native download before trusting its internal manifest/keys.
Current `openMachineArtifact` requires an independently supplied SHA-256 of
the complete `release.json`, then authenticates exact object chunks/extents.
It has no release-signature verifier or key-rotation resolver. A digest fetched
beside the descriptor is not an independent trust anchor; no key is learned
from an unauthenticated descriptor itself.

The signed delivery-root design in [STORAGE.md](STORAGE.md) does not mean this
digest-pinned reader already verifies publisher signatures. Signing-key
custody, exact public-file/DER fingerprints and external-download bootstrap
are in [PACKAGE.md](PACKAGE.md). Volume secrets/head pins and gateway
certificate pins approve different objects, never an Artifact release.

### Ordinary ELF proof spelling

The optimized native program remains an ELF64 x86-64 `ET_EXEC` or `ET_DYN`.
Proof scalars are global `STT_NOTYPE`, `SHN_ABS` entries in the ordinary
`SHT_SYMTAB`; no private execution section or sidecar is accepted. Runtime
program-header byte extents stay at their linked coordinates. Non-runtime
section tails may be replaced by the canonical note, symbol table, string
table, and section-name table.

The GNU build-id descriptor is exactly 32 bytes:

```text
build_id = SHA256(complete_output with build_id[0..32) set to zero). (24)
```

The reader recomputes (24), so changing a load byte, proof value, section
coordinate, padding byte, or trailing byte rejects. The source SHA-256 stored
in the proof binds the optimized output to its linked input; native
differential execution and the cost gate bind the semantic and performance
claims. Stripping the symbol table destroys the proof and therefore destroys
publishability, though it never creates a second runtime format.

Size and execution cost are independent gates. The optimized ELF byte extent
must be strictly smaller than `source_bytes`. Output work and span must both be
no greater than input, at least one of them must be strictly smaller, and
executable code bytes may not grow. Code-size reduction alone is not described
as execution acceleration. Native retired instructions, cycles, faults, and
cache misses remain measured release evidence rather than self-reported proof
fields.

## Publication gates

Build-side certificates are deleted after these conditions are reproduced:

* a total closure witness proves an upper bound for every finite population;
* reachability and distinction provide the matching lower bound for every
  quotient population;
* every population generator is total on `[0,N)`, every rank is used, and no
  vector length is accepted as evidence for `N`;
* every executable byte coordinate is a direct function or exact fault;
* all direct arms and all event classes are closed;
* every merged state has equal output and all-event successor classes;
* every finite function equals predictor plus residual on its complete domain;
* subset and multiset ranks decode to one strictly canonical support;
* `pack(unpack(bytes))` reproduces identical bytes;
* truncation, duplicate support, zero support values, nonzero padding, trailing
  bytes, and changed rank reject;
* changing delivery projection does not change executable identity;
* dropping every opened row and cache page changes no observation;
* execution has no Python, JavaScript, STEP, decoded-x86, or table fallback;
* publication rejects one unclosed coordinate rather than deferring it to a
  runtime `missingBlock`;
* input x86 and optimized x86 pass native differential execution;
* optimized x86 improves the declared native cost objective before a Wasm
  projection is publishable;
* the secondary Wasm projection passes differential execution against the
  accepted optimized x86.

## Historical materialized baseline and last migration checkpoint

The numbers in this section describe the deleted machine-pack route. They are
retained as falsification data for the linear families that the new writer
must beat; they are not the output of the current distribution build. The
present primary route ends at a proved ordinary optimized ELF and the complete
release-root gate. No canonical release word is published yet, so there is no
honest current `standard_release_size` to quote.

The schema-2 materialized baseline was 405,847,385 bytes:

| current field | bytes | noncanonical cost |
| --- | ---: | --- |
| immutable nonzero memory pages | 121,176,064 | byte/extent quotient is incomplete and filesystem extents can be copied into boot RAM |
| fixed entry-tail rows | 50,579,456 | dense materialization of (17) |
| fixed residual states | 31,830,528 | table columns before complete functional minimization |
| fixed residual edges | 76,863,360 | `u24/u32` table for (18) |
| instantiation and parameter pages | 30,437,688 | reconstructable parameters are materialized |
| modules and module index | 71,208,337 | descriptors repeated 12,590,720 lifted-constant bytes |
| resource and delivery directories | 23,196,528 | digest, extent, key interval, and offset are repeated |

The last PBD5/PCP2/PTP1/PLPARM2/RSTATE2/STQT2 Linux delivery checkpoint was
106,715,403 bytes, a 299,131,982-byte (73.71%) reduction from that baseline.
The pack contains 3,611,984 bytes of delivery directory and 103,103,419 bytes
of authenticated object payload.  Relative to the immediately preceding PBD4
pack, the same-boundary pack size falls from 119,357,062 bytes by 12,641,659
bytes (10.59%); excluding each pack's delivery directory, payload falls from
115,586,774 to 103,103,419 bytes (10.80%).  The independently generated
compiled projection falls from 108,681,147 to 96,197,792 payload bytes.  These
figures deliberately keep their accounting boundaries separate.

The independent C verifier for that checkpoint covered
19,202,048 closure coordinates, 335,144 topology functions, 9,608,716
residual states, and 10,787,718 residual edges with zero lowering failure.
Its exact stored terms are:

| current field | bytes | next unresolved quotient |
| --- | ---: | --- |
| module payload and index | 11,485,952 | optional terminal fields remain fixed-width and page-local |
| residual-state generator | 22,405,343 | page-local base ranges dominate; cross-page kernel prediction is not yet priced |
| instantiation and parameter generators | 21,927,361 | exact identity rows still carry separate topology/offset/count columns |
| resource and delivery directories | 11,499,424 | object framing and interval paths remain separately authenticated |
| entry-tail generator plus binding index | 15,530,509 | entry classes and source-page coverage remain separate populations |
| residual-edge generator | 12,278,095 | exception support and correction payload remain page-local |
| immutable memory exceptions | 4,384,787 | clean 114,573,312-byte SquashFS backing is referenced, never materialized here |

PBD5 makes the enclosing PCP2 page, rather than each descriptor occurrence,
own format/version/framing.  A descriptor record now begins with flags and a
field bitmap followed by a shortest-form template-rank ULEB.  The PCP2 endpoint
column supplies its exact extent, so per-record magic, version, total length,
witness length, and fixed-width rank disappear.  Constants use the same unique
three-bit shortest literal classes as PLPARM2.  Structural coordinates share
one minimal width byte and one bit-packed stream; the selected STQT2 template
already supplies their count and group boundaries.  Nonminimal ULEB/literal
classes, an over-wide coordinate column, nonzero padding, alternate extents,
and trailing witness bytes reject.

Template identity remains separate from descriptor occurrence.  A template is
an exact STQT2 record in a PTP1 resource page.  Each PTP1 page stores
`first_rank`, a strict `u16` endpoint column, and the concatenated records;
publication fills the 4 KiB page until the next complete record cannot fit.
The resource-index key is the first rank, so one authenticated floor lookup
selects the page and one endpoint pair selects the record.  There is no global
digest table and no direct template-object path.

The verifier requires ranks to begin at zero and tile without gaps, rejects a
non-final page if the first record of its successor would still fit, and
revalidates every nested STQT2 record and all reserved/padding bytes.  Thus
page boundaries are part of the canonical spelling, rather than a publisher
choice.  The Linux closure publishes 119,469 templates in 1,781 PTP1 pages:
6,847,448 exact STQT2 bytes occupy 7,203,932 authenticated page bytes.  The
335,144 topology descriptors occupy 10,447,058 bytes in 2,771 PCP2 pages,
down from 22,525,905 bytes in 5,809 PBD4 pages.  PBD4, PCP1, and direct
per-template object lookup have no readers.

The sparse witness itself is unchanged in meaning.  For every new topology
the compiler greedily substitutes zero for each candidate constant, decodes
the resulting SSA plan, and retains the substitution only when the
parameterized body is byte-identical.  The surviving logical row contains
12,590,720 constant bytes and 4,780,904 coordinate bytes.  PBD5's canonical
literal and coordinate streams reduce its stored witness to 3,850,662 bytes;
metadata is 1,804,837 bytes and the unchanged optional terminal fields are
4,791,559 bytes.  The independent verifier recomputes those terms for every
descriptor.  PBD2 and PBD3 also have no reader.

PLPARM2 replaces 37,159,376 bytes of fixed-width `u64` parameter words with
canonical tagged literals and page-local group offsets.  The parameter pages
are 12,041,281 bytes; together with the unchanged 9,886,080-byte
instantiation population, this family is 21,927,361 bytes.  PLPARM1 has no
reader.

RSTATE2 removes the last wholly unchanged baseline family.  The prior state
page stored 1,024 kernel ranks as an unconditional `u24` column plus two
degree bitplanes, which cost exactly 31,830,528 bytes.  Each 64-state group now
chooses the unique shortest of direct, range-base bitpacking, prior-delta,
first-occurrence dictionary, and affine-plus-exception support.  On the full
kernel, no group chooses direct: 141,789 choose range-base, 2,297 prior-delta,
4,240 dictionary, and 1,811 affine.  The independent reader reconstructs all
9,608,716 kernels, reselects the canonical mode, and accounts for exactly
22,405,343 bytes.  This removes 9,425,185 bytes from the complete pack.
RSTATE1 has no reader.

STQT2 removes fixed-width materialization from the normalized SSA topology.
The preceding spelling stored a 52-byte header, both ends of every prefix-sum
column, one byte per tag, and one `u64` per retained node/projection word.
The instruction end is now derived from start plus instruction count; the ten
remaining scalar fields use shortest-form ULEB32; waves and argument lists
store bit-packed sizes rather than offsets; tags occupy three bits; and all
three tag groups share one minimally wide graph-word stream.  Function and
start remain part of the general compiler format even though all 119,469
published post-quotient templates currently use zero for both.

The independent reader rejects nonminimal ULEB spellings, over-wide columns,
nonzero padding, alternate extents, and trailing bytes.  It recomputes exactly
6,847,448 stored bytes from the current templates: 2,151,483 header,
299,716 wave, 576,513 lane, 842,621 opcode, 487,337 argument, 1,063,860 tag,
and 1,425,918 graph-word bytes.  The prior templates occupied 28,911,520
bytes.  The complete delivery falls by 22,064,072 bytes from the preceding
159,574,682-byte checkpoint.  STQT1 has no reader.

The earlier 300 MB and 256 MB figures remain useful engineering checkpoints,
but they are not the theorem.  The release target is:

```text
emitted bits <= structural lower bound
                + self-delimiting framing
                + unresolved predictor gap
                + declared authentication/locality cost.       (22)
```

The compiler prints all four terms before a final byte target is accepted.  It
also prints, for every population, its proved upper bound, matching lower
bound, total-generator length, and exact exception count.  The current
`9,608,716` residual states, `10,787,718` residual edges, and `335,144`
topologies are inventories of constructed rows, not such bounds; they cannot
justify release size or minimality on their own.

That pack was a measured checkpoint, not a minimality theorem.  Its
manifest now records all seven baseline families, their exact stored bytes,
the total closure/future populations, zero uncovered coordinates, and zero
retained fixed semantic rows.  Those are upper-bound certificates.  The
remaining `exception_bytes` still need matching lower bounds before they may
be called irreducible.  The largest measured families are now the 22,405,343-
byte residual-state generator and 21,927,361-byte instantiation/parameter
generator.  In particular, the separately delivered residual state and edge
families total 34,683,438 bytes.  They exist because the current backend emits
successor-free bodies and then restores direct control from tables.  The next
normal form moves that control into the independently runnable optimized x86;
the Wasm backend must derive the same direct transfers from that accepted x86
program rather than retain a second graph.  The delivery target for that step
is 75,000,000 payload bytes or less.

## Migration order

1. Prove upper and lower population bounds for (17)--(21), then measure their
   exact supports, candidates, and unresolved code-length gaps.
2. Add exhaustive 256-value tests and complete-domain linked-image tests.
3. Bind the canonical virtual Byte* view and compare every logical lookup
   without emitting an opened word.
4. Project its selected spelling through STORAGE.md, record every term of
   (22), and prove
   the complete Linux image is materially smaller than the old pack.
5. Delete fixed tail rows, residual pages, duplicate digest directories,
   repeated descriptor constants, Wasm-first publication, and all old readers.
6. Emit independently runnable optimized x86 from the accepted word and pass
   input/output native parity and performance gates.
7. Lower only the accepted optimized x86 to Wasm and pass backend parity with all
   runtime fallbacks disabled.
8. Bump the executable format once.  The product runtime keeps no compatibility
   reader.

## Construction memory is not retained artifact population

Proof construction uses borrowed immutable byte spans and generated observation
rows. The program observation is the constant semantic family/domain plus the
borrowed instruction span; it is read on demand by the same exact sharing and
finite-future algorithm, not stored as another row per state. Digest radix
ordering still opens collision candidates and compares every byte; eliminating
the observation array does not relax equality or remove either complete proof.

Executable fragments enumerate only nonempty state intervals and nonempty
image prefix/suffix intervals. Empty states still have checked coordinates but
do not consume fragment descriptors. The sole fragment owner array is
transferred into the complete payload view. Reconstitution compares selected
representative spans directly with each original ELF interval and validates the
final extent; no whole-ELF reconstruction buffer or unused state-to-fragment
index is needed. Program/future scratch is allocated after fragment scratch has
been released. Geometrically grown state columns are sealed to actual population
and the insertion index is dropped when ingestion ends.

Future proof and block/payload rank-map construction also have disjoint
lifetimes. One working arena is measured as the maximum of those three
requirements, not their sum. The initial program proof and the complete
release recheck both finish before block-rank construction, which finishes
before payload-rank construction. Observation/scratch views borrow the arena;
the durable child/level trees retain their own storage, and rank lookup reads
only those trees after construction. Reusing scratch therefore cannot alias
the retained maps or skip a proof pass.

These are transient build-memory reductions, not deductions from published
release bytes or claims of a globally minimal program. Both isolated stage
fixtures and the complete fixed distribution must pass their original proof and
native execution gates after such a lifetime change.

## Implementation ownership

| responsibility | implementation |
| --- | --- |
| linked x86 closure and optimized ordinary ELF emission | `postlink-compiler/src`, `postlink-compiler/cli` |
| optimized ELF proof reader and verifier | `optimized-x86/src`, `optimized-x86/cli` |
| canonical object, global block-future, resource and rank-index primitives | `artifact/src`, `support/src/future.c` |
| complete release-word publisher and size report | `build/artifact-executable-stage`, `distribution/packaging/optimize-payload.sh` (full fixed-root result still required) |
| secondary Wasm projection | `wasm-compiler/src` (library boundary only; product CLI/runtime connection remains required) |
| browser execution of accepted projections | **required after the optimized-x86 and Artifact gates** |
| artifact publication tests | `artifact/check`, `check/complete-release.c`, `distribution/packaging/check-optimize-payload.sh` |
| storage and delivery projection | [STORAGE.md](STORAGE.md) |
