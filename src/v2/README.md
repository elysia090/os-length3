# Quotient Minimizer — v2

> Paste a small C function and see how little machine computation its
> observable meaning actually requires.

v2 is the interactive product from [`SPEC.md`](../v1/SPEC.md): open a URL, paste
C, press **Compile**, copy the program. Compilation, solving and verification
all happen on your machine — there is no account, no upload and no server
component.

Two cards: what you paste, and what QM made of it — ready to copy, ready to run.
Tabs hold one kernel each, with their own source and their own last result. The
language is read off the paste rather than picked from a menu.

The minimized program is viewable as any of the machines it lowers to, or as
the codec: one canonical artifact, `pack(code(z))`, shown as the bytes it is —
with the fields of the code named — and then the listing those bytes decode to.
That artifact is what **Run** executes, and what `vm/` renders back out as C,
x86-64 or wasm32.

Intrinsics are read, not just emitted. `_pdep_u64`, `_pext_u64`, the BMI1 set,
`_tzcnt`/`_lzcnt`/`_bzhi`, byte swaps and rotates, and the SSE carry-less
multiply idiom — `__m128i`, `_mm_clmulepi64_si128` and the scalar moves around
it — all evaluate, so a kernel already written the fast way analyses as readily
as the obvious one. `qm/cfront/intrinsics.py` holds the table, shared by the
reference interpreter and the compiler so the two cannot disagree.

Assembly goes in as well as out. Paste an x86-64 listing or a wasm32 function
and QM evaluates it, minimizes it, and lowers again — so x86 → wasm and
wasm → x86 are the ordinary pipeline with a different target selected at the
end, and running a listing through it a second time gives the same listing
back. `examples/ranks8.s` and `examples/prefix_xor64.wat` are there to press
Optimize on.

```
C / C++                     x86-64 · wasm32
  ↓  Clang/WASM  -O2          ↓  evaluate the listing
optimized code  ────────────────┘
  ↓  execute over the declared input domain
semantics
  ↓  observation quotient · future quotient
normalized operations
  ↓  specialized solvers
minimal physical representative
  ↓
verification
```

---

## Run it

**In a browser** (the product):

```sh
python3 tools/serve.py        # serves this directory, opens the page
```

**On the command line** (the same pipeline):

```sh
python3 -m qm.cli examples/ranks8.c
python3 -m qm.cli examples/select8.c --observer low:8 --json
```

**Tests** (standard library only, no dependencies):

```sh
python3 tests/run.py          # every core
python3 tests/run.py -j 1     # one process, plain unittest output
```

---

## What it does with `ranks8`

```c
uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;
    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(m & ((1u << i) - 1)) << (8 * i);
    return r;
}
```

```
Quotient Minimizer        2 core operations       PDEP ; IMUL
Residual freedom          502 solutions
Verification              exact exhaustive, 256 / 256
Artifact                  17,107 bytes            pack(code(z))
```

The same semantic program lowers differently per target, which is the point of
keeping semantic classes separate from mnemonics:

| target | ops | instructions |
| --- | --- | --- |
| x86-64 + BMI2 | 2 | `PDEP IMUL` |
| x86-64 baseline | 5 | `IMUL AND BSWAP SHR IMUL` |
| portable scalar | 5 | `IMUL AND BSWAP SHR IMUL` |
| codec | 4,123 | `ROW` |

The last row is the artifact: one instruction, and the thing Run executes. It
comes from the *abstract* program the minimizer produced, not from the paste
and not from any of the rows above — three spellings of one function give the
same bytes, which `tests/test_vm_codec_view.py` checks, and which is the only
thing that makes "canonical form" mean anything. `vm/emit.py` renders it back
out as C, x86-64 or wasm32.

Its number is not a count of listing lines. The specification defines the cost
of a transition on the physical form of the machine — a capture plus a wave
over the rows that had the written cell cached — so `work` is transitions plus
incidences and `span` is transitions, and a run of `ranks8` is 1,624
transitions against 6,728 cells of image. See `vm/README.md`, which also says
how far that is from what the same function costs written properly.

---

## The curriculum kernels

`examples/` carries the bit-manipulation exercises from CMU's CS:APP Data Lab,
MIT 6.172 and Princeton's *Algorithms* 4/e, each stated the obvious way. They
are there because they are the ones that used to fall through the grammar: a
comparison between two words, a count, a case analysis on a float's exponent.

| kernel | QM | |
| --- | --- | --- |
| `logical_neg_i32` | 5 | `1 - popcount(x & -x)` |
| `least_bit_mask_u64` | 2 | `x & -x` |
| `popcount_u64` | 1 | `POPCNT` |
| `rabin_karp_roll` | 4 | one reduction of the concatenated word |
| `how_many_bits_i32` | 9 | sign fold, then leading zeros |
| `is_less_or_equal_i32` | 11 | `SPLIT` on `b - a`, two constant pieces |
| `min_i32` | 11 | `SPLIT` on `a - b`, a piece per half |
| `mod_add_u32` | 10 | `SPLIT` on `a + b`: the conditional subtract |
| `float_power2_bits` | 11 | `SPLIT` on the word read signed |
| `float_scale2_bits` | 24 | `SPLIT` on the magnitude, four pieces |
| `round_up_pow2_u64` | 14 | `smear(x - 1) + 1` |
| `max_u8x8` | 43 | the halving tournament, branch-free |
| `middle_bits_u16` | 1 | `PEXT` |

Five more are in `examples/` because they do **not** land, which is a result
and not an omission. `counting_sort8_u2` and `kmp_scan8_fixed` come back as
tables — the interesting number for the second one is its future quotient,
three bits of state against eight bits of history. `float_to_int_bits` and
`strict_sum4_f64` want a shift by a value, and `histogram4_u2x16` wants four
answers in four fields of one output. Each says which of the two it is; none
of them answers with something that merely fits the probes.

The counts above are `work` on the primary target and are checked by
`tests/test_wholeword.py`, so a change that quietly makes one of them longer
fails the suite.

---

## How the browser runs it

Two things run in the page, and the split is deliberate.

**Clang/WASM compiles and executes.** The paste is compiled once, to `wasm32`,
which is instantiated and called over the whole input domain. That is the only
thing the compiler is for. Executing compiled code is why a 16-bit kernel
(65,536 inputs) is extracted in milliseconds rather than in a minute.

There used to be a second compile producing an x86-64 listing for a pane to
show, with a target and an optimization level to choose. The pane is gone and so
are both controls: they changed what was displayed, never what the kernel
computes, and the minimized program is what this page is about.

**Python decides everything else.** Quotients, synthesis, lowering, ranking and
verification run under Pyodide, because that is where the engine lives and where
it is tested. The worker hands Python a table of outputs; Python never sees the
compiler.

The Clang bundle is fetched lazily, on the first run that needs it, so the page
is usable immediately. If it cannot be fetched, the built-in C-subset frontend
takes over and the page still answers.

### Configuring the Clang bundle

No clang-in-wasm build is bundled with this repository. Point the page at one:

```js
// before app.js loads, or via ?clang=<url>
window.QM_CLANG = { driverUrl: 'https://example.com/clang-wasm/driver.mjs' };
```

The driver contract is one function, so any build can be adapted with a short
shim:

```js
export async function init(onProgress) {}          // optional
export async function compile(args, files) {
  // files: { '/in.c': '<source>' }
  return { status: 0, stderr: '', files: { '/out.s': '…', '/out.wasm': Uint8Array } };
}
```

`qm/clang.py` prepends a freestanding prelude and strips `#include <…>`, so the
bundle needs **no sysroot** — that is the difference between a ~50 MB download
and a ~300 MB one.

---

## Deploy

The site is static: no server code, no build toolchain beyond Python.

**Cloudflare Workers** — run from the **repository root**, where
`wrangler.toml` lives:

```sh
npx wrangler deploy    # [build] assembles dist/ first
```

The config is at the root, not here, for two reasons: Workers Builds runs its
git integration from the repository root, and the `name` has to match the
connected Worker script. The `[build] command` assembles `dist/` as part of
`wrangler deploy`, so no build command has to be configured in the Cloudflare
dashboard for the git integration to work. `npm run deploy` runs the suite
first, so a red test cannot ship.

**GitHub Pages** — `.github/workflows/pages.yml` runs the same
`tools/build_site.py`, so the two deployments cannot drift apart.

Either way the layout is the same, and it matters: `web/qm-manifest.json` names
the engine modules the worker fetches at runtime, so `qm/`, `web/` and
`examples/` must sit next to each other under the site root.

---

## Layout

```
vm/               the rSUBLEQ machine the minimized program normalizes onto
  codec.py        one complete self-delimiting code, one rank
  image.py        one canonical finite-support signed memory
  machine.py      one transactional instruction  (3.1, what it means)
  rows.py         the direct physical form        (3.2, what it is; 3.7 cost)
  lower.py        abstract program -> canonical image (bit-sliced)
  emit.py         canonical image -> C, x86-64, wasm32
  wasm/vm.c       the same machine, freestanding, ~6 KB of wasm32

qm/
  bits.py         PDEP/PEXT/CLMUL and the byte-lane constants
  observer.py     §3   obs : Output -> Observable
  semantics.py    §4   the finite domain, and its verification strength
  quotient.py     §5   observation quotient, future quotient
  program.py      §6   POINT / LIN_CONST / CONV / PERM_DYN / SPLIT / TABLE
  guards.py       §7   guards derived from the multiply family
  solvers.py      §8   specialized Stage-2 solvers
  isa.py          §10  target profiles, §11 physical representatives, SSA DAG
  recognize.py    §16  known primitives
  corpus.py       §19  semantic keys, §20 opt-in contribution blobs
  clang.py        §2   the Clang entry point (native driver)
  cfront/         the offline fallback frontend
  asmfront/       §2   x86-64 and wasm32 read back in
  frontend.py     frontend registry: clang · precompiled · cfront · asm
  pipeline.py     the whole product in one call
  browser.py      route / plan / finish, the calls the worker makes
  cli.py          §21  the local interactive product on a terminal
  straightline.py compiles a straight-line integer program to a function

web/              the page: index.html · app.js · worker.js · clang.js
tools/            serve.py · gen_manifest.py · gen_examples.py · build_site.py
tests/            run.py and the suite
examples/         the kernels the corpus is built from, plus two listings
```

Each module states which SPEC section it implements and imports only from lower
layers. `web/qm-manifest.json` lists the files the worker installs into Pyodide;
`tests/test_browser.py` fails if it drifts from what is on disk.

---

## Design notes

**LIN_CONST is not another name for PDEP.** A `LIN_CONST` node carries the
linear map itself — the images of the input basis — and `isa.py` searches PDEP,
PEXT, constant CLMUL, constant IMUL, a masked shift into either multiply, a
multiply/mask/BSWAP spread and a shift/XOR network, keeping whichever survives
verification most cheaply. That is why the portable target gets a 5-op answer
instead of "cannot lower", and why `(s >> 7) * 0xFF` comes out in three
instructions rather than as a twenty-instruction XOR network.

**Span and work are different numbers.** A lowered program is an SSA DAG, so
span is the critical path and work is the instruction count. A balanced XOR tree
has work 7 and span 3, and the report says so.

**Don't-care bits come from the observer, never from the data.** A bit that is
constant across the whole test domain is still part of the contract. The default
observer is the identity on the declared return width; `low:8`, `high:8`,
`mask:0x…`, `byte:K` and `nonzero` are explicit choices.

**The lookup table is a fallback, not a minimum.** A finite domain always admits
a table, and under a plain (span, work) comparison a 2 KB table would "win"
every 8-bit kernel with one instruction. It is reported, and ranked last, so
that "no solution" means "no compact solution" rather than "QM gave up".

**Nothing decides per input what it can decide once.** Verifying a lowering
sweeps the declared domain — 65,536 points for a 16-bit kernel, and a hundred
solves do it — so the lowered sequence, the normalized program and both
assembly readers are each written out as one Python function and the sweep
calls that, rather than walking an instruction list and testing opcodes. Each
has one implementation, not a fast path beside a reference one, and the suite
checks that the single-input and swept forms agree.

**Minimizing a minimal program returns it unchanged.** QM reads its own output
in all three languages — the emitted C uses `_pdep_u64`, `_pext_u64` and
`qm_clmul64`, and `asmfront` evaluates the emitted x86-64 and wasm32 — so
idempotence is a property the suite can check, and does, for every example and
in both directions between the two machines.

**The examples are measured against hand-written optima.**
`examples/lanecode.h` is a header of kernels written by hand in their best known
form; `examples/*.c` states the same functions the obvious way; and
`tests/test_lanecode.py` requires QM to get from one to the other, same
representative and same constants, without being told either.

**Verification strength is never overstated.** Domains up to 2^16 are exhaustive
and reported as such. Wider domains get basis, boundary and deterministic
differential probes, and every report of one says in as many words that it is
not a proof of global equivalence.

**A comparison between words is a different class from one within a lane.**
`lt_spread8` asks the same question about eight bytes at once and answers in
eight bits; `isLessOrEqual` asks one question about two halves of a word and
answers in one. The first is a `POINT` predicate and the second is a `SPLIT`:
a whole-word key, thresholds on it read off the data, and one program per
piece. Nothing branches — every piece is computed and blended under a mask
that is one subtraction's sign bit — so a four-way case analysis still has a
span and a work count rather than a mispredict. `float_scale2_bits` is four
pieces and twenty-four instructions where it used to be a 64 KB table.

**A split's pieces are fitted, not searched.** A piece runs as far as one
affine map still explains it — over GF(2), over the integers in the word, or
over the integers in the key the split already compared — and it is closed at
the first key value none of the three can. That is what stops the class from
becoming a lookup table written sideways: there are at most eight pieces, and
each one is a map that two points determine and the rest of the piece checks.

**A reduction is where the output stops having the input's shape.** Population
count, leading and trailing zeros, the maximum over the lanes, a reduction
modulo a constant: each answers with a number, and no deposit, convolution or
lane predicate produces one. They are `POINT` steps because they are where the
grammar stops being linear, which is what `POINT` has always meant. The
modulus is read off the observed outputs the way a lane interval is read off
the observed lanes — `Q` when the values are exactly `0 .. Q-1` — and it lowers
to a reciprocal multiply, which is why `rabin_karp_roll` comes back as four
instructions rather than as a 64 KB table.

**The chain search counts instructions, not moves.** `smear`, the sign fold and
the reductions are one move each and up to twelve instructions each, so a
breadth-first search that returned its first hit would answer a logical
negation with a cascade. Every chain that reaches the target at a given depth
is collected and the cheapest is offered first: `!x` comes out as
`1 - popcount(x & -x)`, five instructions, and `round_up_pow2` as
`smear(x - 1) + 1`, which is fourteen because in this grammar there is nothing
shorter.

**Comparison is a semantic class, not three of them.** A per-lane `==`, `<` or
pair of bounds arrives as one abstract step carrying the interval; the equality,
one-sided and two-sided forms in `lanecode.h` are three physical
representatives, chosen during lowering the way LIN_CONST chooses between PDEP
and a shift-XOR chain. The interval and the lane width are both read off the
observed data — every input carries eight independent observations of the same
byte-local predicate, so a domain far too sparse to characterise a 64-bit
function still sees all 256 lane values a few hundred times each.

---

## Deliberately not done yet

* **Cycle-level benchmarking** (SPEC §17). The browser sandbox cannot time
  machine code; the Benchmark panel shows the static cost model and says
  explicitly that measured cycles need native execution (SPEC §27). Nothing in
  the UI presents an op count as a timing.
* **Quotient-aware candidate generation** for non-identity observers (SPEC §5.1).
  Generation uses exact values and acceptance uses the declared observer, so
  results are sound but the search may miss solutions a quotient-aware generator
  would find. The report states this rather than implying otherwise.
* **A bundled Clang/WASM build.** The driver interface and the whole path around
  it are implemented and tested against a native Clang; no wasm build of Clang is
  vendored, and I could not reach a CDN from the environment this was written in
  to verify a specific one.
* **A shift by a value.** The grammar has shifts by constants, and a dynamic
  gather, and nothing between them. `float_to_int_bits` needs one — the shift
  is by the exponent — so its exponent field is thirty-three cases rather than
  four and it comes back as the table. `strict_sum4_f64` needs one for the same
  reason, in the normalizing step of every partial sum, and comes back as no
  program at all. A dynamic shift is a data-dependent permutation and belongs
  in `PERM_DYN`; it is not there yet.
* **Several answers in one output.** An abstract program is a chain, so there
  is no way to say "these four counts go in these four bytes".
  `histogram4_u2x16` is four lane predicates and four population counts, each
  of which the grammar has, and it still has no program because they have to
  be combined. Solving an output field at a time — and joining the results —
  is the next class, and it is the one that would also make
  `counting_sort8_u2` something other than a table.
* **Quotient-aware branch fitting inside a split.** A piece is fitted with an
  affine map, and only an affine map; a piece whose answer is a deposit and a
  convolution is not recognized as one, because the fit that finds the pieces
  is the same fit that names them. Running the full solver set per piece would
  reach further and cost a solve per piece.
* **The paid surface** (SPEC §22-§32): API, CLI-over-API, CI, batch, private
  cache, native oracle, team workspaces. v2 is the free interactive product only.
