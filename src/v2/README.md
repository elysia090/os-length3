# Quotient Minimizer — v2

> Paste a small C function and see how little machine computation its
> observable meaning actually requires.

v2 is the interactive product from [`SPEC.md`](../v1/SPEC.md): open a URL, paste
C, press **Run**, copy the program. Compilation, solving and verification
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
back. `../../corpus/lanes/ranks8.s` and
`../../corpus/bit-linear/prefix_xor64.wat` are there to press
Optimize on.

```
C ──Clang/WASM──┐
                ├──> wasm32 / x86 input ──> QM ──> minimized wasm32
x86 / wasm32 ───┘                                  │
                                                   v
                                                codec
                                                   │
                                                   v
                                  fast VM in x86-64 or wasm32
```

The browser uses C only as a frontend: Clang produces wasm32, and QM analyses
that result. Human-authored wasm32 and x86-64 enter at the same QM boundary.
The minimized wasm32 sequence is the only input to codec compilation; the VM
then runs the resulting image in its x86-64 or wasm32 implementation.

Automatic analysis removes `main` and minimizes the selected function. Run
executes the same source snapshot's `main`, whose selected-function import is
answered by the codec VM. The explicit whole-program state frontend is a
separate analysis path: it makes the wasm PC, call stack, locals, globals and
memory explicit, stops at imported input, and derives a pure
`state, byte -> state` function without changing what Run reports.

---

## Run it

**In a browser** (the product):

```sh
python3 tools/serve.py        # serves this directory, opens the page
```

**On the command line** (the same pipeline):

```sh
python3 -m qm.cli ../../corpus/lanes/ranks8.c
python3 -m qm.cli ../../corpus/lanes/select8.c --observer low:8 --json
python3 -m qm.cli program.wasm --state-main --json
python3 tools/qm_compiler_wasm.py llvm.core.wasm --out compiler.wasm
python3 tools/physicalize_wasm.py compiler.wasm
python3 tools/build_compiler_distribution.py llvm.core.wasm \
  llvm-resources.tar --out compiler-dist --version 22.0.0-git20542-10
```

The last command is the large-module path used for YoWASP itself. A compiler
invocation is not treated as a scalar kernel: arguments, clocks, randomness and
the virtual filesystem remain host state. The tool scans internal code bodies
without materializing the 75 MB module as an instruction object graph. Closed
scalar functions use whole-expression QM; additional straight-line
integer/memory functions are lowered to state-step pages for a physical-route
audit. Multiple parameters remain independent SSA inputs; they are not packed
into a sampled domain. On
`@yowasp/clang@22.0.0-git20542-10`, the 75,532,134-byte core contains 133,398
defined functions; 5,124 scalar functions are fixed points and 2,605 additional
state functions reach physical SSA with 14,181 operations. Of those, 1,952
also have a direct typed-Wasm diagnostic spelling: their 8,253 physical
operations become 8,305 after publication rematerializes 52 operations. The
other 653 are still valid physical pages and do not depend on having such a
spelling. Stateful pages are not re-encoded or installed beside the physical
executor, and the compiler Wasm remains intentionally byte-identical.
The component adapters likewise contain only host wrappers and indirect-call
trampolines in this grammar. A zero replacement count is a result, not licence
to rewrite host state or claim sampled compiler equivalence.

Byte-identical does not mean physically serial. After dead-value removal those
5,124 slices contain 4,179 computation nodes with an aggregate dependency span
of 3,860. There are 157 slices with more than one independent lane; the widest
wave has 7 lanes and the longest slice has span 10. `qm.wasmphysical` schedules
each live SSA node by dependency depth, so one wave writes distinct slots in
parallel. In the machine-state route, ordinary linear-memory loads/stores are
nodes in those same waves. Calls, atomics, host operations, faults, and
observable control transfers remain barriers.

Those schedules have mapped physical forms. `qm.scalarpage` stores a
target-shaped scalar SSA sequence, `qm.steppage` stores one maximal pure state
step, and `qm.pagearchive` is the coordinate-ordered directory over independent pages. Each codec is columnar,
8-byte aligned, and validated only when its page is selected. The directory
has no duplicate hash index. For an exactly proved right-zero `Byte*` future,
the last byte is the direct 256-slot cache coordinate and the resume token;
the transition itself stores nothing because `next(_state, byte) = byte`.

The complete core has 24,856,928 decoded instructions in 103 opcode groups.
Its segmented `(function, pc)` view derives 24,724,978 ordinary `rank + 1`
coordinates and stores none of them. This sequential view preserves code
location; it does not impose execution order inside a dependency wave.

The browser does not load the package's generated JavaScript wrapper. On the
first automatic C analysis it fetches the pinned `llvm.core.wasm` and
`llvm-resources.tar` in parallel, verifies their SHA-256 hashes, and connects
the core's 29 WASI Preview 1 imports to an in-memory filesystem. The core asks
Clang for its cc1/link plan and the same core executes each step. The three
component adapter modules are outside this path. The compiler lives in a
disposable Worker; after its compiled wasm result is transferred out, an idle
timeout releases the core, its instance memories, and the resource filesystem.
The codec VM lives in a second disposable Worker, so its linear memory can be
released without closing the page and rebuilt from the retained artifact on
the next Run. After releasing the VM instance, a memory-free standby Worker is
started in advance so Worker startup does not become the next Run's dominant
cost. A deployment can point
`QM_CLANG.compilerCoreUrl` at a normalized `compiler.wasm`; its expected digest
is supplied as `QM_CLANG.compilerCoreSha256`.

The distribution command makes that deployment input explicitly. It produces
only `compiler.wasm`, `compiler-resources.tar`, and deterministic
`compiler.json`; the installed package and generated adapters are build inputs,
not runtime dependencies. The manifest records both binary digests and the
normalization/QM report.

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
Residual freedom          511 solutions
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
comes from the minimized wasm32 sequence, never directly from C, a pasted
listing, or the solver's abstract program. `tests/test_vm_codec_view.py` checks
that different spellings of one function produce the same bytes. `vm/emit.py`
renders the VM image back out as C, x86-64 or wasm32.

Its number is not a count of listing lines. The specification defines the cost
of a transition on the physical form of the machine — a capture plus a wave
over the rows that had the written cell cached — so `work` is transitions plus
incidences and `span` is transitions. Carry-free lane-coordinate lowering now
puts one feed and one read of `ranks8` at 225 transitions and 1,067 image cells,
down from 1,624 and 6,728. See `vm/README.md` for the physical comparison.

---

## The curriculum kernels

The categorized top-level `corpus/` carries the bit-manipulation exercises from CMU's CS:APP Data Lab,
MIT 6.172 and Princeton's *Algorithms* 4/e, each stated the obvious way. They
are there because they are the ones that used to fall through the grammar: a
comparison between two words, a count, a case analysis on a float's exponent.

The names and topics follow the primary course materials: the
[CS:APP Data Lab handout](https://csapp.cs.cmu.edu/3e/datalab.pdf),
[MIT 6.172 Lecture 3: Bit Hacks](https://ocw.mit.edu/courses/6-172-performance-engineering-of-software-systems-fall-2018/resources/lecture-3-bit-hacks/),
and the *Algorithms, 4th Edition* sections on
[key-indexed counting](https://algs4.cs.princeton.edu/51radix/),
[KMP](https://algs4.cs.princeton.edu/53substring/KMP.java.html), and
[Rabin-Karp](https://algs4.cs.princeton.edu/53substring/RabinKarp.java.html).
Examples that narrow or pack the original inputs say “adapted from” in their
comments; `max_u8x8` and `strict_sum4_f64` carry no university attribution.

| kernel | QM | |
| --- | --- | --- |
| `logical_neg_i32` | 5 | `1 - popcount(x & -x)` |
| `least_bit_mask_u64` | 2 | `x & -x` |
| `popcount_u64` | 1 | `POPCNT` |
| `rabin_karp_roll` | 4 | one reduction of the concatenated word |
| `how_many_bits_i32` | 8 | sign fold, then leading zeros |
| `is_less_or_equal_i32` | 10 | `SPLIT` on `b - a`, two constant pieces |
| `min_i32` | 11 | `SPLIT` on `a - b`, a piece per half |
| `mod_add_u32` | 9 | `SPLIT` on `a + b`: the conditional subtract |
| `float_power2_bits` | 11 | `SPLIT` on the word read signed |
| `float_scale2_bits` | 24 | `SPLIT` on the magnitude, four pieces |
| `round_up_pow2_u64` | 14 | `smear(x - 1) + 1` |
| `max_u8x8` | 43 | the halving tournament, branch-free |
| `middle_bits_u16` | 1 | `PEXT` |

Five more are in the corpus because they do **not** land, which is a result
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

The execution boundary is ownership, not source language. Browser-reachable
guest CPU state, memory and control belong to `vm.wasm`. Python, C, wasm32 and
x86-64 are all valid guest or build inputs; none is allowed to introduce a
second runtime owner. Compiled scalar functions are located in their original
Wasm bytes and interpreted by the resident VM over the whole input domain.

There used to be a second compile producing an x86-64 listing for a pane to
show, with a target and an optimization level to choose. The pane is gone and so
are both controls: they changed what was displayed, never what the kernel
computes, and the minimized program is what this page is about.

The migration is not complete. Pyodide still owns its native Wasm instance and
filesystem, the compiler core still owns a native Wasm/WASI instance, and Run's
arbitrary `main` still owns a native Wasm instance. These are measured escape
routes, not architectural exceptions. The static audit walks imports, dynamic
imports, module URLs and Workers and reports every reachable alternate owner:

```sh
python3 tools/audit_runtime_routes.py --web-root web --entry app.js
python3 tools/audit_runtime_routes.py --web-root web \
  --entry linux-terminal.js --strict
```

The second command is already strict and empty: x86 Linux enters through
`linux-worker.js`, and CPU, MMU, resident devices and continuation control stay
inside `vm.wasm`. A native cProfile can be classified separately as `build`,
`oracle` or `runtime`; in the last phase every sampled project frame is host
work. Function names cannot claim VM ownership.

The Clang bundle is fetched lazily, on the first run that needs it, so the page
is usable immediately. If it cannot be fetched, the built-in C-subset frontend
takes over and the page still answers.

### Clang artifact

The page lazily imports the repository's fixed `compiler-core.js` adapter and
opens the pinned compiler and resource artifacts by physical page. Executable
driver URLs are intentionally not configurable: allowing an arbitrary module
would create a second, statically unprovable execution route beside vm.wasm.

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
the engine modules the worker fetches at runtime, so `qm/`, `vm/` and `web/`
must sit next to each other under the site root. The categorized source corpus
is compiled into `web/examples.json`; it is not copied into the deployment.

---

## Layout

```
vm/               the rSUBLEQ machine the minimized program normalizes onto
  codec.py        one complete self-delimiting code, one rank
  image.py        one canonical finite-support signed memory
  machine.py      one transactional instruction  (3.1, what it means)
  rows.py         the direct physical form        (3.2, what it is; 3.7 cost)
  lower.py        minimized wasm32 Seq -> canonical image (bit-sliced)
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
                       normalization, known bits, and the three emitters
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

kernel/           Linux-in-Wasm execution, deterministic host state and pages
  host.py         nccc_call64 barriers and lazy direct block-page storage
  machine.py      machine_step(state, event) and the external device ABI
  scheduler.py    resumable kernel threads and setjmp/longjmp continuations
  process.py      user/kernel syscall, TLS, and user continuation boundaries
  browser.py      retained browser sessions and external barrier protocol
  run.py          native LKL wasm entry point and barrier/page trace
  guest/          reproducible read-only virtio root-device wrapper

web/              the page: index.html · app.js · worker.js · clang.js
tools/            serve.py · gen_manifest.py · gen_examples.py · build_site.py
tests/            run.py and the suite
../../corpus/     categorized kernels, physical-array forms, and VM experiments
```

The QM and VM modules import only from lower layers. `kernel/` consumes the
generic Wasm machine but keeps Linux-specific host and scheduler policy outside
QM. `web/qm-manifest.json` lists the files the worker installs into Pyodide;
`tests/test_browser.py` fails if it drifts from what is on disk.

`tools/compact_wasm.py` maps a linked module read-only, skips custom/debug
ranges without copying them, then runs function-local QM over only the retained
semantic core. This is packaging, not a replacement codec: the released codec
is smaller for the stronger reason that it carries one self-delimiting sparse
image and derives every physical array and hot page after opening.

The runtime applies the same boundary to code. It indexes function body byte
ranges without decoding them, then materializes a body's instructions and its
direct `(function, pc)` cache row only when that function is called. Reports
separate total encoded body bytes from decoded body bytes, so a regression back
to whole-module object expansion is visible.

The Linux-in-Wasm machine is a package entry point, not a tool script. From
`src/v2`, run a native LKL module with bounded, resumable execution quanta:

```sh
python -m kernel.run lin.wasm --budget 131072 --max-events 64
```

The report separates logical linear-memory size from resident page bytes and
names every host boundary, thread and timeslice.

The guest wrapper attaches an ext image without copying it into Wasm memory,
mounts it read-only, and reads `/init` through LKL's VFS. `--start-init`
instantiates that dynamic Wasm module over the shared sparse memory, gives it
private globals, table and stack, and connects its syscall imports to the
retained kernel continuation:

```sh
python -m kernel.run kernel-rootfs.wasm \
    --rootfs busybox-rootfs.ext2 --start-init \
    --max-events 3000 --budget 1048576
```

Only block pages read by Linux become resident. The temporary contiguous
`/init` extraction buffer is discarded after decoding; clean root-image pages
and physical codec slices remain independently disposable. Timers advance the
deterministic virtual clock to the next deadline and enqueue their callbacks as
ordinary cooperative continuations. Maximal state-step slices up to a
call/atomic/host/control boundary are substituted into physical-array SSA,
normalized by QM, encoded, and compiled directly from one mapped state-step
page on their first execution. Non-atomic loads/stores carry explicit memory
versions inside the page: an exact dominating store substitutes a later load,
while remaining byte coordinates use the direct 256-byte page cut described in
[Tail-Byte Quotient / CSR Map Rank](https://length3.com/tail-byte-quotient-csr-map-rank).
The construction SSA is then released; scalar node reconstruction is available
only to diagnostics. Page locals are sparse changed-coordinate patches rather
than dense identity projections. Raw Wasm arithmetic cannot be encoded or
executed as a state-step page.

Multiple values live at a barrier are treated as the outputs of one persistent
SSA cut. Renamed Wasm carries no provisional wave graph: one canonical cut pass
owns liveness, CSE and dependency waves. Only then are closed backward slices
visited in descending work order. Each accepted result is recomposed into that
same cut, and a candidate is installed only when both work and span are
non-increasing. The minimizer cannot return to the pre-cut Wasm SSA. This lets
partial QM improve a VM continuation without requiring the entire future state
to collapse to one scalar result. The stateful VM also retains that derived physical
executor across `load`, `feed`, and `read`; the executor is excluded from the
semantic state key and may be discarded and rebuilt.

Ordered guest operations do not each force a persistent state. Branches,
non-atomic loads/stores, globals, and direct guest calls carry the current
physical frame and touched byte coordinates forward as a transient residual.
For each 256-byte page, one bit domain says which final coordinates cover the
source; covered loads and complete-page commits do not read the older page.
Adjacent final coordinates publish as one segment. A complete `MachineState`
is sealed only where an import/host, fault, interrupt, top-level return, or
execution budget can observe it. On the current 18-event read-only-rootfs LKL
sample, 95 states are materialized and 30,956 internal states are carried.

Reached physical pages belong to the decoded module rather than an individual
executor. A later executor reuses the immutable normalized page and its
opcode-bound lane function, while counters and continuations remain private.
This removes the `compile_slice -> normalize -> pack/unpack -> compile` fixed
cost from repeated runs and prevents minimized lanes from re-entering the
generic Wasm numeric dispatcher. The ECHO `vm_load` measurement is about 0.089
seconds for the first construction of 127 pages and about 0.0076 seconds for a
new executor after those coordinates have been reached.

The distinction is observable in generated artifacts. `web/vm.wasm` has 13
state operations in physical form but needs 15 when encoded back to typed
Wasm; the compiler core has the 8,253 / 8,305 split above. The Linux reductions
reported here are mapped state-step pages, not rewritten `.wasm` bytes. The
current native `WebAssembly.compile/instantiate` routes for the compiler,
Pyodide and Run are therefore known bypasses: they cannot receive the
physical-page reduction until they consume the same state-step codec directly.

Linux does not take that bypass. `web/linux-worker.js` opens the canonical boot
and native-machine projections and passes their page sources to `vm.wasm`.
Only block/page faults, console, clock and other machine events cross back to
JavaScript. A root image remains an HTTP range source; only requested physical
coordinates become resident. Terminating the Worker releases the VM linear
memory and resident pages together.

The private storage projection now has a ciphertext-only admission boundary in
`web/ciphertext-storage.js`. Canonical pages are quotiented before compression;
an exact capacity-ordered partition trades padding against whole parity groups;
data rows are AES-GCM sealed; both data and parity rows carry a separate
HMAC-SHA-256/128 authenticator bound to an opaque keyed locator. Memory, local,
CDN, and object tiers can therefore promote only ciphertext. A page becomes
resident only after row authentication, optional VM erasure reconstruction,
AES-GCM open, frame/decompression, and canonical digest/extent verification.
Every object projection uses a public 256-bit CSPRNG salt and role-separated
HKDF contexts. Protocol, algorithm, salt, row coordinate, capacity class, and
frame identity are canonical AAD. A row coordinate can be sealed once; retry
returns its retained immutable ciphertext instead of reusing an AES-GCM nonce.
Erasure inverse matrices are direct encrypted-directory state, while the hot
GF(256) byte combine executes its minimized artifact through vm.wasm's exact
16-bit cache in one call per useful shard rather than a JavaScript byte loop.
Filesystem metadata and the fixed-size root descriptor are separately sealed,
and the head is one opaque linearizable compare-and-swap. The current public
`PGB1` compiler/VM bundles remain the migration source format; they are not
misrepresented as confidential, and are removed only after their builders and
the vm.wasm erasure callback emit the ciphertext directory contract.

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
`../../corpus/lanes/lanecode.h` is a header of kernels written by hand in their best known
form; categorized corpus `.c` files state the same functions the obvious way; and
`tests/test_lanecode.py` requires QM to get from one to the other, same
representative and same constants, without being told either.

**Verification strength is never overstated.** Domains up to 2^16 are exhaustive
and reported as such. Wider domains get basis, boundary and deterministic
differential probes, and every report of one says in as many words that it is
not a proof of global equivalence.

**A lowering is assembled, so it has to be normalized.** Each abstract op is
lowered on its own, and each branch of a split is lowered on its own, so what
comes out is correct and says several things twice: the same field extracted
once per branch, a mask that cannot clear anything, a multiply by `0x800000`
where a shift was meant. None of that is a fact about the kernel and all of it
is counted by `work`, `span` and `L(z)` — so `isa.normalize` rewrites, folds,
shares and prunes to a fixed point before anything is measured or verified. A
multiply by a power of two becomes a shift, `x - (-125)` becomes `x + 125`, a
deposit into the low bits becomes a mask, adjacent masks and shifts merge, and
a value nothing reads is not computed. Every rewrite is an identity over 64-bit
words, and the composed sequence is still verified over the declared domain
afterwards, so a wrong one would be caught rather than shipped.

**Which masks are redundant is a question about known bits.** `isa.known_bits`
propagates, forwards and conservatively, which bits of each value can be set. A
shift down by 32 leaves nothing above bit 31, so the mask after it is not
clearing anything and goes. The same analysis decides where the listing may use
the 32-bit forms: a 32-bit destination zero-extends, so `xorl` computes `xorq`
exactly when neither operand nor result has an upper half. The input is assumed
unknown even though the domain declares a width — a listing takes its argument
in a 64-bit register, and a caller with something else in the top of it should
still get the answer the C would.

**The listing is written the way the instruction set allows.** A constant that
fits a sign-extended 32-bit immediate is one, rather than a `movabsq` into a
scratch register and a second instruction to use it; a value whose last reader
is the current instruction is overwritten in place, which removes the `movq` in
front of nearly every operation. `float_power2_bits` was twenty-nine lines of
assembly and is now seventeen for the same eleven instructions. None of that
changes the program, so the check is that the reader still evaluates it to the
same function — and that a real assembler accepts it, which
`tests/test_normalize.py` asks it to.

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
