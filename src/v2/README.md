# Quotient Minimizer — v2

> Paste a small C function and see how little machine computation its
> observable meaning actually requires.

v2 is the interactive product from [`SPEC.md`](../v1/SPEC.md): open a URL, paste
C, press **Optimize**, copy the assembly. Two panes, no prose. Compilation,
solving and verification all happen on your machine — there is no account, no
upload and no server component.

Three cards: the C you write, what the compiler made of it, and what QM made of
that — ready to copy. Tabs hold one kernel each, with their own source and their
own last result.

Intrinsics are read, not just emitted. `_pdep_u64`, `_pext_u64`, the BMI1 set,
`_tzcnt`/`_lzcnt`/`_bzhi`, byte swaps and rotates, and the SSE carry-less
multiply idiom — `__m128i`, `_mm_clmulepi64_si128` and the scalar moves around
it — all evaluate, so a kernel already written the fast way analyses as readily
as the obvious one. `qm/cfront/intrinsics.py` holds the table, shared by the
reference interpreter and the compiler so the two cannot disagree.

```
C / C++
  ↓  Clang/WASM  -O2
optimized code
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
python3 tests/run.py
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
Clang -O2                 77 x86-64 instructions
Quotient Minimizer        2 core operations       PDEP ; IMUL
Residual freedom          502 solutions
Verification              exact exhaustive, 256 / 256
```

The same semantic program lowers differently per target, which is the point of
keeping semantic classes separate from mnemonics:

| target | ops | instructions |
| --- | --- | --- |
| x86-64 + BMI2 | 2 | `PDEP IMUL` |
| x86-64 baseline | 5 | `IMUL AND BSWAP SHR IMUL` |
| portable scalar | 5 | `IMUL AND BSWAP SHR IMUL` |

---

## How the browser runs it

Two things run in the page, and the split is deliberate.

**Clang/WASM compiles and executes.** The paste is compiled twice with the same
`-O2`: once to `wasm32`, which is instantiated and called over the whole input
domain, and once to x86-64 assembly, which is what the UI shows and counts.
Executing compiled code is why a 16-bit kernel (65,536 inputs) is extracted in
milliseconds rather than in a minute.

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
  frontend.py     frontend registry: clang · precompiled · cfront
  pipeline.py     the whole product in one call
  browser.py      plan / finish, the two calls the worker makes
  cli.py          §21  the local interactive product on a terminal

web/              the page: index.html · app.js · worker.js · clang.js
tools/            serve.py · gen_manifest.py · gen_examples.py · build_site.py
tests/            run.py and the suite
examples/         the kernels the corpus is built from
```

Each module states which SPEC section it implements and imports only from lower
layers. `web/qm-manifest.json` lists the files the worker installs into Pyodide;
`tests/test_browser.py` fails if it drifts from what is on disk.

---

## Design notes

**LIN_CONST is not another name for PDEP.** A `LIN_CONST` node carries the
linear map itself — the images of the input basis — and `isa.py` searches PDEP,
PEXT, constant CLMUL, constant IMUL, a multiply/mask/BSWAP spread and a
shift/XOR network, keeping whichever survives verification most cheaply. That is
why the portable target gets a 5-op answer instead of "cannot lower".

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

**Minimizing a minimal program returns it unchanged.** QM reads its own output —
the emitted C uses `_pdep_u64`, `_pext_u64` and `qm_clmul64`, and the frontend
models all three — so idempotence is a property the suite can check, and does,
for every example.

**The examples are measured against hand-written optima.**
`examples/lanecode.h` is a header of kernels written by hand in their best known
form; `examples/*.c` states the same functions the obvious way; and
`tests/test_lanecode.py` requires QM to get from one to the other, same
representative and same constants, without being told either.

**Verification strength is never overstated.** Domains up to 2^16 are exhaustive
and reported as such. Wider domains get basis, boundary and deterministic
differential probes, and every report of one says in as many words that it is
not a proof of global equivalence.

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
* **The paid surface** (SPEC §22-§32): API, CLI-over-API, CI, batch, private
  cache, native oracle, team workspaces. v2 is the free interactive product only.
