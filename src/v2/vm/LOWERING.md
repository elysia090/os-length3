# Physical lowering boundary

The rSUBLEQ VM and the compiler that targets it are different layers.

```text
released runtime
  codec -> image -> machine -> residual

optional physical execution
  image -> rows

artifact compiler
  minimized wasm32 Seq -> BitVectorLowering -> framing -> asm -> image
```

`machine.py` defines what one transition means. `rows.py` is the direct
physical form of that same transition. Neither layer knows whether the program
being executed came from bits, words, regions, or a product kernel.

`lower.py` is the codec compiler. It accepts only the minimized wasm32
instruction sequence produced by QM. Its current implementation is explicitly
`BitVectorLowering`; it is not the VM and it does not choose a target ISA.

Before this boundary, every sequence goes through exact local rewriting,
whole-expression extraction, and direct canonical emission, regardless of
instruction count. The old and rewritten forms compete under `(span, work, L(z), rank)`;
being algebraically available never makes a form win by declaration.

The state-step path uses the same boundary. A closed one-coordinate Wasm slice
is normalized before its frame coordinates and selected physical operations
are stored together in one state-step page. There is no second executable scalar page.
Effectful instructions stay outside it as ordered barriers, which is also where
an x86 decoder must cut the basic blocks executed by `kernel.wasm`.

## Sources of the boundary

Pinf-R fixes the runtime dependency order and the released ABI:

```text
codec -> image -> VM -> residual
open / feed / feed* / read
```

Nothing about a bit vector, an ISA operation, a solver, or an array layout may
cross that artifact boundary. A physical lowering must disappear into the
canonical signed image before release.

Kraft Cell supplies the internal coordinate model:

```text
descriptor -> Cell -> boundary rank -> Region -> cut -> residual
```

The useful rule is that carried state is a coordinate or a region. Ordinary
values appear only when an observer applies `select`. Repeated work should be a
cut or an endpoint update, not a copied unrolled graph.

`python-physicalarray-lib` supplies the implementation test for that rule. Its
compact normal path is closed by one of three visible proofs:

```text
coordinate substitution
region cut/composition
endpoint-potential evaluation
```

When none applies it reports `not compact`; it does not silently scan or
materialize. QM should make the same boundary explicit in its artifact
compiler.

## Physical forms before codec compilation

QM needs several forms, selected by the operation's structure before it emits
the minimized wasm32 sequence.

| form | carried state | operations that stay compact | observation cost |
| --- | --- | --- | --- |
| bit vector | coordinate-to-bit-cell access plus complement flags | shifts, masks, PDEP/PEXT, BSWAP, constant CLMUL, fixed permutations | materialize requested bits |
| word | one exact signed cell plus declared finite-width observer | integer add/subtract, comparison keys, constant multiply, counters | reduce modulo width or expose bytes |
| region | descriptor and endpoint ranks | loops, repeated strides, scans, bounded dynamic shifts | select only at the requested boundary |
| product | shaped regions, affine access, endpoint moments | independent output fields, histograms, segmented/product reductions | write the final output fields |

Bit-vector lowering is strong because most of its first row is metadata
rewriting. It becomes weak when it rebuilds word arithmetic from Boolean gates.
rSUBLEQ already subtracts unbounded signed words; arithmetic should use that
physical action and apply the finite-width observer only where the program
requires it.

Likewise, copying a loop body is not a region representation. It increases the
number of resident rows that read hot cells and therefore increases the wave
work in Section 3.2. A loop carries endpoint ranks and reuses one body.

## Conversion is an observed operation

A conversion between forms is never implicitly free.

```text
bits -> word     materialize a finite-width integer
word -> bits     observe selected bit coordinates
word -> region   establish descriptor and checked endpoints
region -> word   observe a boundary rank or endpoint potential
```

Every conversion must provide:

1. its exact semantics under the declared observer;
2. a canonical rSUBLEQ expansion;
3. measured `(span, work, L(z), rank)` after lowering;
4. a differential test against the source form.

The planner may then choose a path lexicographically by the same objective as
the rest of QM. It must not label an operation "word" or "region" inside the
artifact; only the resulting canonical image is released.

## Implementation order

1. **Make the execution path linear.** The browser now selects QM's wasm32
   sequence as the sole input to codec compilation. The parallel direct path
   from the abstract solver program has been removed.
2. **Separate framing from the bit-vector form.** `framing.py` now owns only
   the byte `feed`/`read` convention. `BitVectorLowering` owns the current
   instruction representation.
3. **Add a word form for arithmetic islands.** Productionize the word-level
   multiply already measured by `tools/measure_multiply.py`. Start with a
   closed island whose input and output conversions are explicit, and select it
   only when its complete artifact cost wins.
4. **Replace repeated framing and stride bodies with regions.** Counters become
   endpoint ranks; the loop body is emitted once. Verify the open-state and
   code-level residual paths still agree.
5. **Add product/field composition.** A result with several independent fields
   is a product observation, not a longer unary chain. `histogram4_u2x16` is the
   first regression: four reductions joined into four output fields.
6. **Add bounded dynamic permutation through a region.** `float_to_int_bits`
   and `strict_sum4_f64` are the regressions for a shift selected by a carried
   endpoint rank.

Each step keeps the old form as a differential reference until the new form is
canonical, cheaper on the full objective, and covered by falsification tests.
The fast gate is `tools/fuzz_frontends.py`: x86-64 and wasm32 readers must agree
over the complete declared domain, and a bounded set must also produce the same
codec artifact through both input routes.

## Non-goals

- Do not add bit-vector, word, region, or product tags to the Pinf-R image.
- Do not move QM semantic classes into `machine.py` or `rows.py`.
- Do not treat a probe match as a global equivalence proof.
- Do not make every operation a general symbolic expression. The normal path
  stays the three closed proofs above; unsupported structure remains explicit.
- Do not optimize row execution to hide a poor lowering. First choose the
  physical form that matches the operation, then measure the VM.
