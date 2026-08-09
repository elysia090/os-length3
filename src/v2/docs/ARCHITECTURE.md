# Architecture

## Layers

Each module imports only from lower layers, so the dependency graph is a DAG and
any layer can be read on its own.

```
0  bits  straightline        PDEP/PEXT/CLMUL, GF(2^128), masks, probe streams;
                              compiling a straight-line program to a function
1  observer  semantics        obs : Output -> Observable; finite domains
   guards    version
2  quotient  program          the two quotients; the abstract op grammar
3  cfront/   clang  asmstats  frontends: source -> semantics
   asmfront/  x86oracle       x86-64/wasm32 fast readers; native x86 fallback
   wasmstate  wasmvm          linked wasm -> clonable whole-program/VM state
   wasmphysical              wasm code/state coordinates -> physical arrays
   wasmbinary                 large wasm -> closed function-local QM
   frontend                   registry: clang · precompiled · cfront · asm
4  solvers   isa              Stage-2 search; ISA profiles and lowering
   recognize corpus
5  pipeline                   the whole product in one call
6  cli  browser               the two front doors
```

`pipeline.solve()` is the only thing either front door calls, so the CLI and the
browser cannot diverge in behaviour.

## Browser execution path

The product path has one direction and one target at the codec boundary:

```text
C source --Clang/WASM--+
                         +--> QM --> minimized wasm32 Seq --> codec --> VM
x86-64 / wasm32 listing-+
```

C is a browser frontend, not another execution backend. A pasted `main` is
removed before the selected scalar kernel enters this path. Once the kernel's
codec artifact exists, the browser compiles the same source snapshot's `main`
to an import-only wasm32 driver and preloads the VM. Run remains disabled until
that exact tuple `(source, artifact, driver, VM)` is ready, then only
instantiates it. An edit invalidates the tuple; another tab's later solve
cannot replace it because the worker cache is keyed by the complete source.

Automatic compilation is therefore the executable function-level analysis,
not a preview that Run repeats. The driver contains no selected kernel body:
its import is answered by a wasm export of the already loaded codec VM, so
kernel calls do not cross JavaScript. Codec compilation never consumes C
directly.

A translation unit may contain `main` without a separate scalar kernel. That
is still a runnable program: the browser compiles the complete unit to wasm and
prepares Run without inventing a scalar quotient or demanding a particular C
function signature. Input that has no scalar entry and no `main` is an idle
editor state, not a C-specific diagnostic.

Cold startup begins the compiler core, codec VM and Python/QM runtime together.
They have no data dependency before source analysis, so making their downloads
and wasm compilation a serial chain only delays the first valid Run tuple.
Readiness still waits for all three and the button remains inert until then.

The VM export keeps an exact result cache for scalar domains through 16 bits.
For the stronger byte-register form it first checks all 256 byte observations;
only when they prove the one-row right-zero transition law does every non-empty
history in `Byte*` reduce to its final byte. That path is a direct state write
and read in wasm. Other artifacts stay on the transactional VM and are cached
only by values actually proved by execution.

`main` is not sent through the scalar-function minimizer. It is an environment
adapter whose loop carries state. Explicit state-machine analysis derives the
pure interface

```text
step(state, input-byte) -> (next-state, output-action)
```

directly from linked wasm and closes its reachable future quotient exactly.
If the graph does not close below the declared state limit, the frontend
refuses; it never treats a bounded prefix as proof. Treating the driver as an
ordinary scalar function would discard the state and I/O that define it.

That potentially large closure is not on the interactive Run path: it is an
analysis product, not a prerequisite for executing an artifact already proved
at the scalar boundary. Analysis is function-scoped. At present one analysable
non-`main` function is selected and every other definition is reported as not
analysed. A whole-file Run therefore means one prepared function artifact plus
its driver, not an implicit claim that every helper was minimized.

## Stateful quotient boundary

`qm.transducer` closes an explicit deterministic `step/out` graph and refines
it to the exact reachable future quotient. Its build representation follows a
coordinate-first form: state, byte and shared-row domains are rank regions in
power-of-two cells; each access map is constant, affine or explicitly dense;
and equal transition rows share one storage region. The cell descriptor uses
the same framed omega word as Kraft Cell. For the echo residual, 256 reachable
states close to 256 future classes, while its build representation reduces the
square transition relation to five stored coefficients: affine output,
constant row selection and affine byte projection.

`qm.vmquotient` applies that construction to an opened VM residual and gives a
canonical complete-future key for comparing candidate artifacts. The quotient,
class table, coordinate maps and closure states are proof data. They are not
serialized and are not an inference shortcut. After an equivalent candidate
is selected by the exact finite-closure key `(worst span, worst work, L, rank)`,
runtime still receives only its canonical codec artifact and derives VM rows
from the opened image. The regression pair uses two echo VMs with the same
complete future: the redundant candidate has key prefix `(7, 7, 437)` and the
selected one `(5, 5, 165)`. This keeps stateful QM from quietly introducing a
second evaluator while proving that the selected VM program actually shortens
the hot transition chain. The selected form is the production echo seed: its
image has 17 cells instead of 29 and a feed takes one transition instead of
five.

`qm.wasmstate` supplies that graph for a compiled C `main` or a wasm VM body.
Its primitive executes exactly one wasm instruction on an immutable
`MachineState`; running to the next imported input call is therefore a pure
composition of steps. Binary control flow, direct calls, integer operations,
mutable globals and linear-memory loads/stores are represented explicitly.
Unsupported host imports or instructions are named and rejected.

`qm.wasmphysical` gives the same decoded program two physical views. The
logical `(function, pc)` domain is a segmented dense instruction region;
opcodes are dictionary-coded and immediates use one packed offset column.
Ordinary fallthrough is the affine `rank + 1` map inside a segment and stores
no edge. A second view groups equal instruction shapes into contiguous spans,
with an inverse position map back to sequential ranks. Locals and stack slots
use `frame_base + index`; linear memory uses `(address // 256, address % 256)`.
This is layout metadata for compiling a state step, not a competing evaluator.
Pure stack slices are first substituted into SSA. Their physical execution
domain is `(dependency wave, lane)`, not source instruction order:
`schedule_sequence` assigns a node to one plus the maximum depth of its inputs.
Every value in one wave reads only earlier waves and writes a distinct SSA
slot, so it has no lane order, atomic update, or reduction. Work is the number
of live nodes and span is the number of waves. Memory effects, calls, and
control transfers end a slice and form explicit barriers between waves.

`qm.wasmvm` opens a canonical artifact through the real `vm_buffer` and
`vm_load` exports, then uses that retained wasm memory as the state of
`vm_feed(byte)` and the source of `vm_read()`. The 32 MiB reservation is an
immutable shared base with 256-byte copy-on-write pages, so a store no longer
copies the reservation. At load time, `vm.wasm` also checks whether feed can
change only the input cell and exhaustively runs the ordinary transactional
reader over all 256 byte values. When that complete check proves a byte
register, its state step is substituted as `next(state, byte) = byte`; the
future quotient stores five affine/constant coefficients rather than a
256-by-256 table. Other artifacts keep the generic transactional engine.

Large tool modules use a narrower boundary. `qm.wasmbinary` indexes the code
section without expanding a complete module into Python objects, then admits
only integer functions whose bodies contain no calls, memory, globals, traps,
or control flow. Their stack expressions become SSA, undergo whole-expression
substitution and normalization, and are re-encoded only when both wasm work and
body bytes decrease. This is the path used for YoWASP's `llvm.core.wasm`;
WASI arguments, clocks, random input and virtual files remain explicit host
state and are never treated as constants.

The browser enters that core directly. `web/drivers/compiler-core.js` lazily
fetches the version-pinned compiler module and resource tar in parallel and
checks their digests. `web/wasi-preview1.js` supplies exactly the 29 imported
Preview 1 operations over an in-memory filesystem. Clang first prints its cc1
and linker plan with `-###`; fresh instances of the same multi-call core execute
those steps. The generated package wrapper and the three component adapters do
not participate. The compiler artifact URL is configurable, so a normalized
and QM-processed `compiler.wasm` can replace the raw upstream core without
changing the frontend contract.

## The frontend boundary

A frontend produces `Semantics`: a callable on a declared finite `Domain`, plus
a report. Nothing downstream knows whether the values came from Clang, from the
built-in interpreter, or from a table computed in JavaScript.

That is what lets the browser put the expensive part where it belongs. The
worker compiles with clang.wasm, executes the wasm32 module over the domain, and
hands Python a table; `frontend.PrecompiledFrontend` wraps it and the pipeline
proceeds identically to the native path.

It is also what makes x86 → wasm and wasm → x86 ordinary uses of the pipeline
rather than separate features. `asmfront` evaluates a pasted listing the same
way the Clang path evaluates a compiled module, `frontend.AssemblyFrontend`
wraps it, and the target selector on the far end decides which machine comes
out. A listing does not record how wide its input was meant to be — `%rdi` is
64 bits whether the kernel took a byte or a word — so the emitters write a
`qm-input-bits:` line and the readers read it back; without it the width is
assumed and the report says so.

The text readers are fast paths. Linked wasm uses the explicit binary machine.
For x86-64, a sandbox-capable Linux host can assemble and disassemble the input,
reject machine/environment observations, and evaluate the finite domain under
seccomp and resource limits. Thus an opcode missing from the lightweight x86
reader is not itself a coverage limit. Hosts without that sandbox refuse the
fallback rather than execute pasted code with ambient authority.

## Decide once, not once per input

Everything QM claims rests on evaluating something over a declared domain, and
a 16-bit kernel has 65,536 points in it. Four things used to walk their own
program per input and re-decide what each instruction was: the lowered
sequence, the normalized abstract program, and the two assembly readers. None
of those decisions depends on the input, so each is now written out once as a
Python function — `straightline.build` assembles the source and compiles it —
and the sweep calls that function.

The generated source is closed: every name in it is a temporary this package
named or a helper it passed in, and every constant is formatted from an `int`.
Nothing from a paste reaches it. `fn.qm_source` keeps the text on the function,
because a tool whose claim is that you can check what it computed should not
have a step you cannot read.

In each case there is one implementation and not a fast path beside a reference
one — `isa.run` calls `isa.compile_seq`, `asmfront.wasm.evaluate` calls its
compiled form — and the suite checks the two entry points agree. A fast path
that could drift from the reference would mean the verification counts in the
report describe a different program from the one that gets emitted.

The same rule shapes the primitives. `pdep`, `pext` and `clmul` walk the set
bits of a mask rather than all 64 positions, and `clmul` walks whichever
operand has fewer — the product is symmetric, and the constants these kernels
multiply by are often dense while the values are not.

## Running the suite

`tests/run.py` hands test *classes* to a pool of worker processes. `solve` is a
pure function of its arguments, so `tests/support` memoizes it; the shared
inputs are solved in parallel up front and the workers are forked afterwards,
which is what stops each of them from recomputing the twenty examples it
happens to need. `-j 1` runs the plain serial unittest runner.

## Why the lowering is an SSA DAG

Candidates are ranked by `(span, work, L(z), rank)`, while core operations,
machine instructions, and microarchitectural cost remain distinct.
A chain representation makes span and work the same number by construction, so
`isa.Seq` is an SSA DAG: span is the critical path, work is the instruction
count, `L(z)` is the description length of the encoded program, and `rank` is
the encoding itself, compared lexicographically.

The encoding is accumulated as bytes rather than as one big integer, because a
2^16-entry lookup table encodes to about four million bits and materialising
`1 << bits` for it costs more than the rest of the pipeline put together.

## Ranking

Candidates are lowered on a sample of the domain and ranked; only the winner is
then lowered and verified over the whole domain on every target. Fully verifying
every rejected candidate on every ISA is work whose result is discarded.

The finite-domain lookup table is ranked as a fallback rather than as a minimum.
It always verifies, which is what makes "no solution" mean "no compact
solution", but it answers storage rather than minimum machine computation.

## Exact normalization before ranking

Every lowered sequence, including one with fewer than five operations, is
normalized before it is measured. Instruction-local folding runs to a fixed
point first. A second pass then extracts the final whole-SSA expression when
it belongs to one of two closed algebras:

- affine integer expressions modulo 2^64 are rebuilt as at most one scale and
  one offset;
- GF(2)-affine bit expressions are rebuilt from their exact 64-bit basis and
  factored by equal shifts.

The extractor maps each SSA value to an exact algebraic form, keeps only the
requested result, and emits its canonical program directly; it does not emit a
chain of substituted intermediates. Both forms are identities over all 64-bit
inputs and are not inferred from probes. The original and rebuilt sequences remain separate
candidates, and the rebuilt form is adopted only when the ordinary objective
selects it. Target-specific neighbors, such as a portable logarithmic
shift/OR/mask network for constant bit deposit, use the same rule.

`tools/fuzz_frontends.py` exercises the boundary directly. It generates one
SSA function, emits x86-64 and wasm32 listings, parses both, compares every
input in the declared finite domain, and sends a bounded prefix through full
QM and wasm32-to-codec compilation. A failure prints a deterministic seed and
the two pasteable listings.
