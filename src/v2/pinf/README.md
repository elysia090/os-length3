# pinf — Pinf-R codec → image → vm

The runtime half of Pinf-R: one self-delimiting code, one canonical signed
memory image, one transactional rSUBLEQ instruction. Nothing here is a search,
a proof, or a learner.

```text
codec  ->  image  ->  vm
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

`wasm/pinf.c` is the fast path — 300 lines of freestanding C with no allocator,
no libc and no imports, compiled to a ~6 KB wasm32 module.

Neither is checked against a description of the other. `tests/test_pinf.py`
runs both on the same artifacts and requires identical answers, which is how
the one real divergence so far was found: the C counted a scalar word's zero
run with `while (at < len && !bit())`, so a word truncated exactly at the
payload end decoded as the value 1 instead of being malformed. One side had a
live image and the other had the dead residual, for the same file.

## Three departures from the specification, all reported

The specification's machine has unbounded signed integers and no step limit.
A wasm module has neither, so:

| Specification | `wasm/pinf.c` | How it is reported |
| --- | --- | --- |
| unbounded integers | i64 | a subtraction that would overflow ends the call and raises `pinf_overflowed`; it never wraps |
| unbounded memory | fixed open-addressing table | exhausting it is a finite failure, never a silent eviction |
| divergence is divergence | step budget | exhausting it returns `UNFINISHED` (-2), which is **not** an outcome: not a byte, not a failure |

The Python reference has none of these limits, which is what makes the
differential test meaningful rather than circular.

## Building

```sh
python3 pinf/wasm/build.py            # writes pinf/wasm/pinf.wasm
python3 pinf/wasm/build.py --check    # compile warning-free, keep nothing
```

The module is built, not committed. The test suite compiles it into a
temporary directory, so a stale binary cannot pass for a current one.

## Using it

```python
from pinf import codec, image, vm

picture  = image.Image({...}, pc_out=3, pc_feed=18)
artifact = codec.pack(codec.code(image.serialize(picture)))

r = vm.open_payload(codec.unpack(artifact))
r = vm.feed(r, 65)
vm.read(r)          # a byte, or None for bottom
```

`vm.read` discards every write, including self-modification, so reading is
observation and nothing else. `vm.feed` keeps its writes only on COMMIT: any
other event yields the one fixed dead residual.
