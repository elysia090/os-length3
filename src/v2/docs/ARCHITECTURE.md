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
   steppage   scalarpage      mapped state-step / scalar-SSA physical pages
   pagearchive                coordinate directory over disposable pages
   wasmbinary                 large wasm -> closed function-local QM
   frontend                   registry: clang · precompiled · cfront · asm
4  solvers   isa              Stage-2 search; ISA profiles and lowering
   recognize corpus
5  pipeline                   the whole product in one call
6  cli  browser               the two front doors
7  kernel                     Linux-in-Wasm machine, host barriers, scheduler
```

`pipeline.solve()` is the only thing either front door calls, so the CLI and the
browser cannot diverge in behaviour.

`kernel` is an execution consumer, not a QM frontend or a diagnostic tool. It
imports the generic Wasm state machine from `qm`, owns Linux-specific host and
scheduling state, and is not part of the browser's eager Pyodide manifest.

## Linux-in-Wasm execution

`kernel.host` decodes the single `env.nccc_call64` import used by the LKL Wasm
port. Linux syscalls and VFS code stay inside the guest. Clocks, synchronization
objects, memory regions and block pages are explicit host state; no operation
implicitly reads the filesystem, wall clock or random source.

`kernel.scheduler` owns cooperative threads. Frames and mutable globals are
private to a thread, while linear memory and host objects share one current
snapshot. A `thread_create` table coordinate becomes a new Wasm continuation
with its own downward-growing stack. Semaphore, mutex and join boundaries park
that continuation instead of blocking the Python or browser worker. Long pure
runs return a resumable timeslice at a cached wave boundary.

`kernel.machine` is the only outer execution boundary. Its operation is
`machine_step(state, event)`: synchronization, allocation, VFS, dcache and
page-cache work stays inside Linux, while only `block_read`, `block_write`,
`console_read/write`, `clock`, `entropy`, and `network_poll` can cross to the
host. Event-backed block reads stop on exactly one `(device, page)` coordinate
and resume only after that page is supplied, so the host never needs a second
pathname table or filename hash.

The 128 MiB allocator pool and 128 MiB stack area used by the reference runner
are logical address ranges. `PagedMemory.grow()` extends only its direct span
directory; a 256-byte page becomes resident after it is written. Block images
use the same principle at a 4 KiB page size. Immutable backing pages and dirty
COW pages occupy separate direct arrays: backing can be released when a Worker
is terminated, while canonical `(page, bytes)` dirty records remain restorable.

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
to an import-only wasm32 driver. Run remains disabled until that exact tuple
`(source, artifact, driver)` is ready. The VM itself is loaded only inside a
disposable execution Worker when Run is pressed. An edit invalidates the
tuple; another tab's later solve cannot replace it because the worker cache is
keyed by the complete source.

Automatic compilation is therefore the executable function-level analysis,
not a preview that Run repeats. The driver contains no selected kernel body:
its import is answered by a wasm export of the codec VM in the same execution
Worker, so kernel calls do not cross JavaScript. Codec compilation never
consumes C directly.

A translation unit may contain `main` without a separate scalar kernel. That
is still a runnable program: the browser compiles the complete unit to wasm and
prepares Run without inventing a scalar quotient or demanding a particular C
function signature. Input that has no scalar entry and no `main` is an idle
editor state, not a C-specific diagnostic.

Cold startup loads only Python/QM. C source creates a compiler Worker on demand;
Run uses a separate execution Worker. After 15 seconds idle the compiler Worker
is terminated. The execution Worker is also terminated, releasing its VM linear
memory, then replaced by an empty standby that has not instantiated `vm.wasm`.
This keeps Worker startup off the next Run without retaining the 32 MiB VM
memory. The parent retains only rebuildable inputs: source, the small compiled
driver, the canonical artifact, its precompiled 8 KiB VM module, and its plan.

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

The completed quotient is also checked for the stronger direct-cache shape:
the alphabet is all 256 bytes, one byte reaches each of the 256 classes, and
every class has the same successor row. Only after all three hold can the last
byte replace a general state identity. The resume token is then one byte,
`next(_state, byte) = byte` has no stored transition table, and any value proved
invariant on that quotient can occupy a direct 256-slot cache. A general finite
machine does not inherit this representation merely because its state count is
small.

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

The execution cache uses those dense `(function, pc)` coordinates directly.
One coordinate entry owns one mapped page and its terminal executable
projection, with stack extent as a validation guard. Source SSA exists only
while that page is built and is then released. The executable is generated
directly from mapped columns; reconstructing `PureSlice`, `WaveNode`, or
`Operand` objects is a diagnostic operation and is not reachable from runtime
execution. Raw Wasm arithmetic is available only while building the source SSA
and cannot be called by the state-step executor.

`qm.scalarpage` and `qm.steppage` materialize those schedules
as fixed-vocabulary, structure-of-arrays pages. Columns and payloads are
8-byte aligned and mapped through `memoryview`; executing a page reads the
selected columns without rebuilding the SSA object graph. The target grammar
is part of a scalar page, so `ranks8` has span 2 for BMI2 (`PDEP`, `IMUL`) and
span 6 for the portable wasm32 representation rather than one unnamed cost.
`qm.pagearchive` keeps a canonical coordinate-ordered directory over
independent pages. Lookup searches that resident directory directly—there is
no duplicate hash index—and only the selected inner codec is validated and
opened. This packed form is also a range-readable model for storing its pages
as separate OPFS objects.

This physical form does not imply eager materialization. Large linked Wasm is
opened read-only with `mmap`; section headers are scanned as byte ranges and
non-semantic custom ranges are skipped without copying them. Only the semantic
core is presented to function-local QM. The core is copied once only because a
new contiguous Wasm artifact was explicitly requested; a no-replacement QM pass
returns that same buffer. Runtime function bodies stay as `(start,end)` ranges
into the mapped code section. Locals, instructions and control tables are
decoded on the first call to that function, and the direct `(function,pc)`
coordinate row is allocated at the same boundary. State-step and scalar pages
remain `memoryview` slices, and block backing is loaded only for the exact
direct page coordinate that faulted.

This follows the physical-array construction rather than ordinary lazy object
loading. A logical domain is carried by a descriptor, axes and endpoint ranks;
an ordinary value appears only at `select`. Closed operations stay as one of:

1. coordinate substitution,
2. region cut/composition, or
3. endpoint-potential evaluation.

An operation that cannot prove one of those forms must stop or cross an
explicit bounded materialization boundary. It must not silently enumerate the
logical domain. The analogous VM object is a coordinate rule plus resident
spans, not an allocation proportional to the logical address universe.

The implementation audit is deliberately more precise than saying "lazy":

| object | carried before observation | materialized boundary |
|---|---|---|
| linked Wasm source | read-only mapping and section ranges | one retained semantic output buffer |
| Wasm code | function body byte spans | instruction/control objects for called functions only |
| linear memory zero tail | logical length | changed or active-data 256-byte pages |
| root block image | `(device,page)` coordinate and a small direct span directory | exact 4 KiB backing page on fault |
| execution codec | coordinate-ordered resident directory | selected state-step payload as a `memoryview` |
| hot transition | `(function,pc,stack_extent)` | one normalized page and terminal transition on first execution; construction SSA is released |

The small direct directories are resident metadata, not a claim of zero
metadata. The payloads and instruction graphs are the expensive objects and
remain demand-derived. The directories can be rebuilt, and clean backing,
decoded pages and the Worker-owned Wasm memory can be discarded independently.

The compact linked-Wasm form and the released VM codec have different reasons
for being small. Linked Wasm shrinks when debug/name/producers custom sections
are omitted; its code and data sections remain ordinary Wasm. The codec in the
Pinf-R specification instead stores exactly one self-delimiting global word
`E(|z|)||z`, so its byte size is `ceil(L(z)/8)`. The payload is one canonical
sparse default-zero image: only increasing gaps and nonzero support values are
stored. Dense slots, dependency waves, decoded rows, page directories and hot
transitions are derived disposable layouts and never become a second codebook
inside that artifact. Kraft Cell regions follow the same rule: a descriptor
and endpoint ranks name the region; selected ordinary values are observations,
not carried storage.

There are four separate size arguments here:

1. For a payload of `n>0` bits, the global framing costs exactly
   `2*floor(log2(n))+2` bits. Thus `L(z)=n+O(log n)`, with no container,
   alignment or per-section tax beyond the final zero-to-seven padding bits.
2. The image is finite support over default zero. It encodes `k`, two entry
   coordinates, then only increasing gaps and nonzero zigzag values. Its size
   depends on the support and logarithms of its coordinates/values, not on the
   largest logical address or a dense memory length.
3. No local codebook, decoder, physical row, proof checkpoint, training corpus
   or scheduler state may be omitted from the length calculation and then
   supplied for free at runtime. Physical layouts are reconstructed after
   `open` and are disposable.
4. When the all-program selector is actually certified, the specification gives
   the comparison bound
   `L(selected) <= L(e) + ceil(log2 T(e)) + ceil(log2(1/P_e(x)))`
   for every admitted capable comparator `e`. For a proved fixed evaluator
   family of `N` futures, the constructive form is `C_e + O(log N)`.

The fourth point is conditional. A product obtained only by materializing a
feed result has no storage theorem, and Kraft equality alone does not promise
that an arbitrary payload is short. Smallness comes from canonical global
framing, sparse support, proof-erased runtime boundaries, and—when claimed—a
certified selector that charges complete artifact length after span and work.

On the measured LKL input, these distinctions are visible. The original
88,629,674-byte linked module contained 79,188,258 bytes of custom/debug
sections and a 9,441,416-byte semantic core. Removing those ranges saved
89.35%; function-local QM replaced zero bodies. This is a packaging result,
not evidence that the Pinf codec compressed Linux instructions. After the code
path became range-backed, initial module indexing fell from about 6.4 seconds
to 0.059 seconds on the same compact module; only called bodies subsequently
became instruction objects.

The same audit applies inside each state-step page. Packing allocates the final
column buffer once and writes fixed-width values into their final offsets; it
does not first build a second bytes object for every column. Locals use a
sparse patch: the header carries the logical local extent, while
`local_indices`, `local_tags`, and `local_values` contain only coordinates whose
output differs from the identity projection. A diagnostic decoder can rebuild
the dense local tuple, but the runtime reads the sparse patch directly. On the
18-event LKL boot sample this changed 1,703 pages from 5,360,464 mapped bytes to
361,176 bytes. There were 1,607 changed local coordinates across those pages,
1,256 zero-work projection pages, and no resident scalar plans. Only 82 of
20,092 function bodies (34,260 of 7,411,642 encoded body bytes) were decoded.

### Persistent cuts and residual state

For a two-phase operation `F(x,y)`, the state that must survive after `x` and
before a future query `y` is not necessarily `x`. It is the equivalence class
of pasts that every allowed future query observes identically. If `Res(F)` is
that set of future behaviours, the minimum persistent description has
`ceil(log2 |Res(F)|)` bits. This is the standard deterministic one-way
communication/residual-counting identity, used here as a layout rule.

That rule distinguishes three objects that a conventional cache often mixes:

1. construction evidence, which may be discarded after the quotient is proved;
2. a sealed residual that crosses a real temporal cut; and
3. a decoder chosen so future observations are local machine operations.

The state-step route now follows this separation. Wasm instructions and scalar
SSA are construction evidence. The mapped wave columns plus sparse output patch
are the sealed residual. The terminal executor is derived directly from those
columns. Function and pc select the page but do not justify retaining a second
decoded expression graph. A barrier coordinate is not stored as a negative
physical page because it has no pure residual payload.

This also identifies the next runtime boundary precisely. Load, store, call and
branch remain ordering barriers, but only a host event, timeslice, fault or
interrupt is a persistent cut. Materializing a complete immutable
`MachineState` after every internal barrier preserves more distinctions than
the future host ABI can observe. The next state-step executor should therefore
carry an internal residual through ordered barriers and seal the full machine
state only at those external cuts. This is not ordinary input memoization and
does not require recompiling a hot block for each value: it changes which state
is allowed to persist between phases.

Residual construction is itself SSA. Renaming produces no provisional wave
layout. One canonical cut pass first owns backward liveness, physical CSE and
dependency-wave construction. Each future-visible stack/local output in that
cut is then a root; its backward slice is the past-side encoder and its root
expression is the future decoder. `qm.stepnormalize` ranks those roots by cut
work and normalizes the dominant root first. It never reopens the pre-cut Wasm
SSA. After each candidate it CSEs and schedules the result back into the same
cut. Because two residuals may share a cheaper prefix, a candidate is retained
only when neither work nor span regresses against the previously selected
physical DAG. On the same LKL sample this moved normalized work from 41,587 to
41,457 and span from 40,926 to 40,848 while retaining one execution route.

`qm.stepnormalize` closes the remaining scalar gap after the persistent cut is
canonical and before its one page is encoded. A future-visible backward slice
with one external stack/local coordinate, one integer width, and no trap is translated to
`isa.Seq` and passed through the same whole-expression `isa.normalize` used by
the scalar frontend. `isa.normalize` includes the source form in its candidate
set, so the canonical winner is always installed even when its `(span, work,
L(z), rank)` ties the input. The selected physical operations and surrounding
frame coordinates are encoded together in one state-step page; there is no raw-Wasm
arithmetic page beside it and no parallel scalar execution page. Loads, stores,
calls, and control transfers still end the block and use the existing process
barrier ABI. A later x86 decoder must feed that same single state-step boundary
rather than introducing an x86-only runtime artifact.

`qm.wasmvm` opens a canonical artifact through the real `vm_buffer` and
`vm_load` exports, then uses that retained wasm memory as the state of
`vm_feed(byte)` and the source of `vm_read()`. In the Python state frontend the
32 MiB minimum is a logical zero-filled address range, not a resident bytes
object: only data and changed 256-byte pages are retained. In the browser the
native linear memory belongs to the disposable execution Worker, so terminating
that Worker releases the reservation. At load time, `vm.wasm` also checks
whether feed can change only the input cell and proves the observer over the
complete byte domain. When that check proves a byte register, its state step is
substituted as
`next(state, byte) = byte`; the future quotient stores five affine/constant
coefficients rather than a 256-by-256 table. Other artifacts keep the generic
transactional engine.

The complete byte check is also physical SSA rather than a scalar 256-call
loop. After the feed row proves the right-zero transition, the ordinary
rSUBLEQ observer is interpreted once with every live cell represented as
`base + step*byte`. Coefficients use the same direct cell coordinates with
epoch tags, so the proof clears no million-cell arena, hashes no state, and
materializes no 256-value table. An observer branch advances only when its
affine interval chooses one edge for all bytes or both edges have the same
target. The direct form is selected only when the emitted affine value is
exactly `(base,step)=(0,1)`; any unproved observer continues to use the one
transactional VM semantics.

On the 21-byte ECHO artifact, one `vm_load` fell from 2.10 seconds to about
0.22 seconds for the first cold page construction and 0.13 seconds after Python
imports were warm while still using a fresh decoded module and executor. Source
dynamic work fell from 60,153 to 2,400 and normalized work from 52,450 to
1,671. The codec reader now scans a zero prefix and value tail by touched byte
chunks rather than reloading the same byte for every bit; this reduced the load
sample from 10,638 to 8,372 Wasm instructions and from 1,893 to 1,673 internal
barriers. The compiled module is 8,839 bytes. The affine coefficient arrays are
zero-initialized logical memory inside the existing 32 MiB reservation and only
reached coordinates are touched. Under the physical objective, persistent-cut
count, work and span are measured before accepting an artifact-size tradeoff.

The physical executor is also a residual of the module, not part of the VM's
semantic state. `load`, `feed`, `read`, and finite-closure construction retain
one executor, so public byte calls do not rebuild the same function SSA, page,
validation, and terminal transition. All derived pages remain excluded from
`state_key`; two snapshots are compared only by the globals and cell coordinates
that later `feed/read` calls can observe. Thus retaining the executor removes
reconstruction work without inventing an additional VM state distinction.

Large tool modules use a narrower boundary. `qm.wasmbinary` indexes the code
section without expanding a complete module into Python objects, then admits
only integer functions whose bodies contain no calls, memory, globals, traps,
or control flow. Their stack expressions become SSA, undergo whole-expression
substitution and normalization, and are re-encoded only when both wasm work and
body bytes decrease. This is the path used for YoWASP's `llvm.core.wasm`;
WASI arguments, clocks, random input and virtual files remain explicit host
state and are never treated as constants.

The browser enters that core directly, but only inside `compile-worker.js`.
`web/drivers/compiler-core.js` lazily fetches the version-pinned compiler module
and resource tar in parallel and checks their digests. `web/wasi-preview1.js`
supplies exactly the 29 imported Preview 1 operations over an in-memory
filesystem. Clang first prints its cc1 and linker plan with `-###`; fresh
instances of the same multi-call core execute those steps. The generated
package wrapper and the three component adapters do not participate. The
Worker returns an exact-sized compiled wasm buffer and can then be terminated
with the LLVM memories and resource filesystem still inside it. The compiler
artifact URL is configurable, so a normalized and QM-processed `compiler.wasm`
can replace the raw upstream core without changing the frontend contract.

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
