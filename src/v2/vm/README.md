# vm — one program, one machine, three views

The runtime half of the Pinf-R specification, plus the two directions that make it the canonical form.

The runtime half of Pinf-R: one self-delimiting code, one canonical signed
memory image, one transactional rSUBLEQ instruction. Nothing here is a search,
a proof, or a learner.

```text
codec  ->  image  ->  machine          the specification's dependency order
                        ^
    qm.isa.Seq  --lower-->  image      C, x86-64 or wasm32 in
                            image  --emit-->  C, x86-64, wasm32 out
```

That order is normative and is also the import order. Nothing in this package
reaches forward to residual algebra, exact numerics, a frontier, a foundation
contract, or a product learner — and nothing here imports `qm`.

## Why it exists here

`qm` minimizes into a declared grammar of GF(2)-linear maps, convolutions,
lane-local steps and gathers. That grammar is small enough for closed-form
solvers and exact minima, and it is why `min`, `max` of packed bytes,
`round_up_pow2`, `popcount` as a number, `(a + b) % m` and float field surgery
come back as *no program in the declared grammar* — see the limitations section
of the top-level README.

rSUBLEQ is a universal one-instruction machine, so every one of those kernels
*is* expressible in it. Expressibility is not minimality: finding the shortest
rSUBLEQ program for a function is the Levin-search half of the specification,
not this half. What this package provides is the thing that half needs first —
somewhere to run candidate programs, exactly and quickly.

## Two implementations, held to each other

`codec.py`, `image.py` and `vm.py` are the definition. They are written for
clarity: bits are strings, memory is a dict, and nothing is optimized.

`wasm/vm.c` is the fast path — 300 lines of freestanding C with no allocator,
no libc and no imports, compiled to a ~6 KB wasm32 module.

Neither is checked against a description of the other. `tests/test_vm.py`
runs both on the same artifacts and requires identical answers, which is how
the one real divergence so far was found: the C counted a scalar word's zero
run with `while (at < len && !bit())`, so a word truncated exactly at the
payload end decoded as the value 1 instead of being malformed. One side had a
live image and the other had the dead residual, for the same file.

## Three departures from the specification, all reported

The specification's machine has unbounded signed integers and no step limit.
A wasm module has neither, so:

| Specification | `wasm/vm.c` | How it is reported |
| --- | --- | --- |
| unbounded integers | i64 | a subtraction that would overflow ends the call and raises `vm_overflowed`; it never wraps |
| unbounded memory | fixed open-addressing table | exhausting it is a finite failure, never a silent eviction |
| divergence is divergence | step budget | exhausting it returns `UNFINISHED` (-2), which is **not** an outcome: not a byte, not a failure |

The Python reference has none of these limits, which is what makes the
differential test meaningful rather than circular.

## The artifact is not yet minimal, and by how much

QM's objective is lexicographic `(span, work, L(z), rank)`. The codec target is
measured on the same scale, and it currently loses on every coordinate — not
narrowly:

| `ranks8` | span | work | L(z) bits |
| --- | ---: | ---: | ---: |
| x86-64 + BMI2 | 2 | 2 | 156 |
| codec | 2,242 | 2,242 | 108,685 |

Some of that gap is real and permanent: a one-instruction machine cannot do a
64-bit deposit in two steps, and it never will. But most of it is this
lowering's fault, in two specific ways, both measured rather than guessed.

**It bit-slices an arithmetic machine.** SUBLEQ's one instruction *is* a 64-bit
subtract, and this builds 64-bit adders out of single-bit gates on top of it —
each gate eight to twelve instructions. The `CONV(IMUL)` stage of `ranks8` is
5,208 of its 6,728 cells for that reason. Written word-level, as the
shift-and-add the machine can do natively, the same multiply is 623 cells and
7,345 bits — **twelve times smaller**, and exact on every input tested.

**It is fully unrolled.** In SUBLEQ every instruction depends on the one before
it through `pc`, so a loop costs nothing in span or work — the chain is the same
length either way — and it collapses L(z) and rank. The same multiply as a loop
over its seven rounds is 232 cells and 2,546 bits: **thirty-five times smaller
than the bit-sliced form**, executing 253 transitions.

The fixed framing shows the same thing from the other end. Byte decode, byte
encode and the stream dispatch are 1,520 cells whatever the kernel is — for
`byte_mask8`, whose program is pure rewiring, that framing *is* the entire
image. Both loops are eight iterations of the same few instructions.

So the order to fix it in is: word-level values with bit-slicing kept only for
the permutation-shaped operations that actually want it, then loops for the
framing and for the repeated-stride stages. Neither is done.

## Building

```sh
python3 vm/wasm/build.py            # writes vm/wasm/vm.wasm
python3 vm/wasm/build.py --check    # compile warning-free, keep nothing
```

The module is built, not committed. The test suite compiles it into a
temporary directory, so a stale binary cannot pass for a current one.

## Both directions

`lower.lower_seq` takes a minimized QM sequence to a canonical image. Whichever
of C, an x86-64 listing or a wasm32 listing was pasted, all three reach the same
lowered sequence and therefore the same artifact — `tests/test_vm_qm.py` checks
that byte for byte.

`emit.emit` takes an image back out as C, x86-64 or wasm32. What comes out is
the machine and the image, not a decompilation: an rSUBLEQ program *is* a
memory and one instruction, and each of the three can say so exactly. Every
emitted form is compiled or assembled with a real toolchain, run, and required
to compute what the artifact computes.

The round trip closes. `tests/test_vm_closure.py` takes a kernel through QM,
lowers the abstract program to an artifact, emits that artifact as C — a
400-line SUBLEQ interpreter over a 6,000-cell memory, which resembles the
kernel in no syntactic way at all — and puts *that* back through QM. What comes
out is the same minimized program, `SHL ANDNR` and one core operation, because
what QM reads is the function rather than the text. If the lowering dropped or
added meaning anywhere, the second pass would land somewhere else.

So the artifact is what is kept and the listings are derived from it. Note what
this is *not*: QM's own `qm.isa.emit_c` / `emit_asm` / `emit_wasm` still emit
the minimized program in each ISA — two instructions of x86 for `ranks8`, not a
SUBLEQ interpreter — and those remain the product's answer to "how little
machine computation does this need". Both families come from one solve; neither
is maintained by hand.

Values are bit-sliced in the lowering, which is why a shift, a deposit, an
extract, a byte swap and a carry-less multiply by a constant cost no
instructions at all: they are rewiring. Bits carry a complement flag, so NOT is
free for the same reason. The gates and the adders are what is left.

## Using it

```python
from vm import codec, image, vm

picture  = image.Image({...}, pc_out=3, pc_feed=18)
artifact = codec.pack(codec.code(image.serialize(picture)))

r = vm.open_payload(codec.unpack(artifact))
r = vm.feed(r, 65)
vm.read(r)          # a byte, or None for bottom
```

`vm.read` discards every write, including self-modification, so reading is
observation and nothing else. `vm.feed` keeps its writes only on COMMIT: any
other event yields the one fixed dead residual.
