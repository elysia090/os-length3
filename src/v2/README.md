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

The minimized program is viewable as any of the machines it lowers to, or as the
codec: one canonical rSUBLEQ artifact, which is what **Run** executes and what
`vm/` can render back out as C, x86-64 or wasm32.

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
Artifact                  13,586 bytes            pack(code(z))
```

The same semantic program lowers differently per target, which is the point of
keeping semantic classes separate from mnemonics:

| target | ops | instructions |
| --- | --- | --- |
| x86-64 + BMI2 | 2 | `PDEP IMUL` |
| x86-64 baseline | 5 | `IMUL AND BSWAP SHR IMUL` |
| portable scalar | 5 | `IMUL AND BSWAP SHR IMUL` |
| codec | 2,242 | `SUBLEQ` |

The last row is the artifact: one instruction, and the thing Run executes. It
comes from the *abstract* program, so it does not depend on which of the rows
above you are looking at — they are views of one solve, and `vm/emit.py` renders
the artifact itself back out as C, x86-64 or wasm32. See `vm/README.md`.

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
  machine.py      one transactional instruction
  lower.py        abstract program -> canonical image (bit-sliced)
  emit.py         canonical image -> C, x86-64, wasm32
  wasm/vm.c       the same machine, freestanding, ~6 KB of wasm32

qm/
  bits.py         PDEP/PEXT/CLMUL and the byte-lane constants
  observer.py     §3   obs : Output -> Observable
  semantics.py    §4   the finite domain, and its verification strength
  quotient.py     §5   observation quotient, future quotient
  program.py      §6   POINT / LIN_CONST / CONV / PERM_DYN / TABLE
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
* **Whole-word comparison, reduction and modular arithmetic.** The declared
  grammar is GF(2)-linear maps, convolutions, lane-local steps and gathers. A
  predicate *within* a lane is in it; a comparison *between* lanes is not. So
  the classic teaching kernels — `is_less_or_equal`, `min`, `max` of packed
  bytes, `round_up_pow2`, `how_many_bits`, `popcount` as a number, `(a + b) % m`,
  a rolling hash, or float sign/exponent/mantissa surgery — come back as "no
  program in the declared grammar" rather than as a wrong answer. `middle_bits`
  is the one of that family that does land, because selecting bits is linear.
  Extending the grammar to reach the rest is a different change from extending
  the search, and neither is done.
* **The paid surface** (SPEC §22-§32): API, CLI-over-API, CI, batch, private
  cache, native oracle, team workspaces. v2 is the free interactive product only.
