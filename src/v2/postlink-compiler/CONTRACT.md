# Post-link compiler and VM contract

This is the acceptance contract and dependency order for the post-link
compiler.  A boot trace is test input; it is not the program being compiled.
The compiler's input is a linked x86 image plus its executable mappings.  Its
primary output is independently runnable optimized x86.  A VM executable is a
secondary verified projection of that accepted native output.  STEP is
internal build-side SSA evidence and must not become the runtime instruction
set.

Its repository-level purpose is the distribution goal in
[`../docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md): apply this same operation
to the fixed profile's kernel image and to every linked `ET_EXEC`/`ET_DYN`
before package signing, prove each optimized ELF equivalent to its ordinary
linked input, assemble the optimized packages into one root, boot it, and
measure canonical size and paired native execution against the same fixed
source identities.  The obligations below are written so that the distribution
is built once and published only when all of them hold together; a partial
application is not a release.

## Acceptance contract

The command-line model is deliberately ordinary:

```text
cc -static source.c -o program
postlink-compiler program -o program.opt
postlink-verify program program.opt
program.opt
postlink-lower-wasm program.opt -o program.modules
```

A self-contained static `ET_EXEC` is accepted directly: decoded control and
address fields plus allocated ELF metadata are its finite construction
evidence. A dynamic `ET_EXEC`/`ET_DYN` must additionally retain static linker
relocations with `--emit-relocs`, because runtime relocations alone do not name
every already-resolved reference that may move. Present construction rows are
closed exhaustively and then discarded from `program.opt`; no sidecar or build
tree is needed to execute, verify, or lower the result. An input missing the
evidence required by its linkage model is rejected rather than sent down a
weaker path.

The compiler emits another normal linked x86 image plus its authenticated
machine contract.  The Linux product applies the same operation to the loaded
kernel image and to each executable ELF before it is published executable.
The browser does not own a second executable loader, decoder, VFS, optimizer,
or interpreter.

Completion requires all of the following:

- `postlink` and its library are C, build without Python or JavaScript, and
  accept a normal linked x86-64 ELF or an explicit raw-image memory map.
- every executable extent is catalogued; both arms of every direct
  conditional and every direct call/jump/fallthrough are closed;
- block identity contains every architectural assumption needed to reuse it,
  while exact code bytes and mappings remain a separate proof identity;
- relocation, alternatives, static-key, ftrace and executable-page generations
  produce explicit variants rather than silently changing one block;
- every byte coordinate of every published executable page maps to a direct
  block function or its architecturally correct fault; an indirect target
  therefore resolves through a total, quotient-shared page-dispatch projection
  and never invokes a decoder;
- compilation fails before publication if any executable coordinate or direct
  edge is not represented; execution never reports `missingBlock`;
- the primary artifact contains native x86 transfer functions,
  page-generation bindings and function ranks, not a boot-observed list of
  scalar STEP programs;
- acceptance minimizes the complete emitted ordinary ELF, not each block in
  isolation. `sigma=max cut span` and `tau=max cut work` are independently
  minimized; publication requires one candidate to attain both minima. Only
  inside that exact physical fiber do final file bytes and canonical ELF byte
  rank select the representation. If the two minima have no joint witness,
  the Pareto frontier remains unresolved and publication fails;
- a universal codec, rSUBLEQ evaluator, candidate generator, and all-program
  frontier are permitted only as build-side search/proof machinery and are
  absent from the output ELF and its runtime dependency closure;
- static successors return a direct function rank; only a true machine
  barrier, fault, halt, or stale page generation leaves the direct chain;
- differential fuzzing and real Linux tests prove the optimized image against
  the unoptimized linked image.

Code admitted later by `exec`, `mmap(PROT_EXEC)`, modules, or runtime patching
is not executable until the same post-link compiler has produced a new page
generation and the supervisor has published it atomically.  The compiler may
itself run as an already compiled VM executable, but it is never a VM
subsystem.  This is one compiler path, not a fallback emulator.

## Canonical identities

Keep these coordinates separate.  Combining them is the source of both missed
sharing and unsafe reuse.

| identity | sufficient coordinates |
| --- | --- |
| linked program | executable bytes, load map, relocation/patch generation |
| decode context | RIP, long/compat mode, operand/address size, required CPU features |
| code proof | executable page generation plus exact relative byte extents |
| transfer class | normalized state projection and barrier behaviour |
| dispatch class | transfer class, normalized predicate, successor classes |
| delivery | page/shard coordinates; never part of semantic identity |

CR3 and physical page coordinates prove a particular mapping but do not belong
in a reusable arithmetic transfer class.  Conversely, CPL, paging mode, CS
mode and feature assumptions cannot be discarded merely because two byte
strings match.

## Critical path

### 1. C input and image writer

- Add a bounded ELF64 reader for program headers, executable sections, dynamic
  relocations and optional symbols.
- Add the explicit raw-image mapping input used after bzImage decompression.
- Make one C container writer authoritative for headers, block directory,
  execution pages, code proofs and the boot cut.
- Provide `postlink`, `postlink-verify` and a library API over caller-owned
  storage.  Temporary build output belongs in the host temporary directory.
- Gate: round-trip an ordinary linked executable and the loaded Linux image
  without importing `kernel/x86snapshot.py`.

### 2. Total x86-64 decode in C

Current status: framing and total architectural decode rows are in C for linked
ELF and raw maps.  On Linux 7.1.8 all 19,186,970 physical-plus-virtual byte
coordinates produce a decoded instruction or explicit fault.  Semantic SSA
lowering remains incomplete; therefore this phase is not yet closed.

- Port instruction framing first: prefixes, REX, opcode maps, ModRM/SIB,
  displacement, immediate and exact instruction length.
- Port semantics by families and make unsupported/invalid encodings an
  explicit compile result, never an absent block.
- Cover the kernel and shipped user toolchain, including SSE/AVX state,
  privileged instructions, segmentation, atomics and exception ordering.
- Key the decode cache by code proof and decode context rather than RIP alone.
- Gate: decode every executable coordinate selected by the closure catalog and
  match the reference decoder on a large generated x86 corpus.

### 3. Total executable-coordinate coverage

Current status: the page catalog is total at the decode/fault boundary and
quotient-shares equal 256-coordinate rows.  Its ranks are not publishable block
functions until every decoded family has C semantics and every direct-outside
edge has an explicit architectural classification.

- Compile every byte coordinate of every executable extent from the linked
  image, not only a realized boot trace or `System.map` symbols.  Invalid
  instruction starts compile to the correct architectural fault.
- Follow fallthrough, both conditional arms, direct calls and direct jumps.
- Preserve call, return, exception, interrupt and page-fault edges in the
  machine model; do not mistake them for absent graph edges.
- Recover finite indirect domains from relocations, jump tables and normalized
  value sets for direct chaining.  A genuinely runtime-defined target uses the
  compiled page-dispatch function; it does not enter the compiler.
- Treat alternatives and other runtime text patches as proof generations with
  monotone variant publication.
- Gate: zero absent direct targets, zero truncated worklists, and a report for
  every remaining dynamic edge explaining its target domain.

### 4. SSA normalization and physical minimization in C

- Port the remaining Python block former and every productive normalization
  rule before deleting its parity oracle.
- Form pure slices between memory fault, call, MMIO, interrupt and host
  barriers; expose their dependency waves directly.
- Run backward liveness from the persistent cut before materializing locals.
- Close store-to-load substitution, call/return stack cancellation, ALU/flags,
  region loads/stores, counted recurrences and affine multiword transactions.
- Use the already minimal physical-array representation throughout; no tuple
  graph or scalar instruction-list detour may remain.
- Gate: all corpus cases and all reachable kernel classes reach a stable
  normal form in one ordered sweep plus one verification sweep.

### 5. Myhill-Nerode dispatch quotient

For a block class `q`, let `T(q)` be its normalized state transfer, `B(q)` its
observable barrier result, and `S(q)` its ordered successor classes.  Refine
the finite partition with

```text
signature[n + 1](q) =
    (T(q), B(q),
     residual_work(q), live_dependency_frontier(q),
     normalize(predicate(q), signature[n](S(q))))
```

until ranks stop changing. `live_dependency_frontier` is the ordered vector of
SSA output heights, not only its maximum. Constants, addresses, source node
ids, and wave ids leave the topology before ranking. An actual common graph
prefix may move to an incoming edge with its code and cost; numeric work may
not be subtracted merely to enable a merge. This is the deterministic weighted
residual behaviour of the block graph.

- A conditional whose two successor ranks are equal becomes unconditional.
- Complementing a predicate and swapping its arms produces the same row.
- Constants and relative RIP values are substituted before ranking.
- Calls whose pushed return coordinate is consumed only by the matching return
  carry the return *class* as a parameter; the store/load pair disappears.
- Dynamic targets dispatch through target-to-class coordinates.  If the whole
  proved target domain has one class, the lookup disappears.
- Code guards never participate in the execution-class rank.  They authorize
  a class projection and remain independently invalidatable.

Gate: stable partition ranks are deterministic, every merge has identical
barrier traces and persistent cuts under fuzzing, and the number of runtime RIP
lookups is measured rather than inferred.

### 6. Emit and verify optimized x86

- Lower each normalized transfer class to ordinary x86 with the fixed native
  machine ABI.
- Emit a total page-dispatch projection for each executable page.  Its domain
  is the page-offset region and its storage is the quotient function-rank
  region.  Pages parameterize shared dispatch functions by access-map rank;
  no fixed block record is materialized per coordinate.
- Keep the linked input x86 and optimized output x86 as separate identities.
  Bind page digest and generation to artifact-local native function ranks.
- Emit static successors as direct ranks and dynamic successors through the
  page dispatcher, without assembling an X86B/STEP record.
- Compose every local alternative into a complete canonical `ET_EXEC` or
  `ET_DYN` candidate before charging size.  Body sharing, veneers, dispatch,
  retained immutable bytes, program headers, alignment and proof-note bytes
  are one objective; a sum of local encoded lengths is not sufficient.
- Before that composition, reject only componentwise dominated physical
  candidates. A span/work tradeoff remains on the Pareto frontier. A locally
  larger body is legal: it may remove global control/layout bytes. The exact
  length/rank gate runs only after the complete ELF or its exact canonical
  Artifact spelling attains both independent physical minima.
- Search the unbounded construction space through one complete prefix code and
  a universal build-side evaluator when useful. Quotient candidates by their
  emitted ELF and complete future. Reject release until every unresolved cell
  has a proved lower bound no better than the incumbent; then delete the
  evaluator image, frontier, closure rows and candidate programs.
- The minimum certificate separately proves the irreducible global span lower
  bound and the independent global work lower bound, then proves that one
  candidate attains both. Only in that joint fiber does it exclude every
  shorter canonical ELF and every equal-length earlier ELF rank. These are the
  exact acceptance obligations, not sampled search coverage.
- A proved fixed native family may encode its selected complete-future rank with
  the canonical bounded-rank branch of the one global Kraft code. For `N`
  admitted futures its maximum parameter width is exactly `ceil(log2 N)` bits:
  the information lower bound and truncated-binary constructive upper bound
  coincide. Final ordinary ELF length reports the exact family constant, packed
  rank bits and standard-ELF framing separately. The family contains native x86,
  not an `N`-row table or an rSUBLEQ runtime. A class count without exact family
  membership supplies no upper bound and must not be advertised as compression.
- The same family certificate reports `max span` and `max work` over every
  admitted rank, complete-future cut and machine event. These are constructive
  worst-case bounds. A boot trace, benchmark sample or timeout cannot supply
  either coordinate.
- The global grammar has a literal branch for every finite ordinary x86 ELF,
  so synthesis rules cannot hide a better x86 spelling by omission. Every
  unresolved grammar cell carries sound independent span/work lower bounds;
  once a cell can still attain both global minima it also carries a sound
  representation bound. Equality between both semantic lower bounds and one
  emitted candidate proves global worst-case span/work optimality on the
  admitted machine ABI.
- Every grammar rule carries a checked physical upper bound. Serial
  composition adds span and work; a parallel wave takes maximum span and adds
  work; a choice adds control cost to the worse executed arm while charging
  both stored arm bodies to ELF length. An unbounded recurrence without a
  closed bound or barrier is not publishable. These bounds must meet the
  independently proved dependency/operation-cut lower bounds before length or
  construction rank can decide publication; profiling is not that proof.
- Gate: the optimized output is independently executable, agrees with the
  original linked program over differential tests, and improves the declared
  native physical objective. It contains no section, symbol dependency, or
  interpreter entry for the build-side universal machine.

### 7. Lower accepted x86 to one VM runtime path

- Lower only the accepted optimized x86 transfer program into bounded Wasm
  modules, then instantiate them against the VM's shared memory and function
  table.  JavaScript may orchestrate module instantiation but never executes,
  optimizes, decodes or reconstructs guest instructions.
- Partition emitted modules at physical hot/cold and barrier cuts.  A module is
  an independently authenticated delivery extent; loading one cold module must
  not reconstruct or compile every other module.  The VM checks function-rank
  residency before `call_indirect` and reports a delivery barrier, never a
  missing compilation unit.
- Keep only a bounded physical-page directory and page-generation to dispatch-
  rank map in `vm.wasm`; delete BigInt directories, record assembly and STEP
  workspaces from the execution path.
- Execute a compiled function and chain its static successor by function rank.
- On executable-page mutation, unpublish the old generation, stop at the page
  barrier, run postlink-compiler outside that execution, then atomically publish
  the replacement.  VM contains no compiler or decoder.
- Keep only compact boot state, dirty physical pages, class/proof directory and
  deterministic barrier log when the Worker is released.
- Gate: browser boot, shell command, release and restore all complete without a
  second VM or VFS.

### 8. Identity growth and bounded residency

The universal code bounds the bits needed to select one member of a proved
fixed family.  It does not make arbitrary toolchain bytes logarithmic: without
the fixed evaluator, an enumeration or lookup table only moves the linear
information term.  The implementation must therefore distinguish unavoidable
unique content from avoidable materialization.

- The machine root names the linked image, compiled modules and immutable
  filesystem extents by digest/generation.  It does not embed a merged
  toolchain root and the same filesystem bytes again inside boot RAM.
- A sparse address-space length is never a request for a dense buffer.  Wire
  directories gap-code nonzero coordinates; opened directories may use bounded
  rank/select pages, and resident storage contains only touched unique pages,
  dirty COW pages and a bounded cache.
- Quotient before compression and encryption.  File/extent identity, zero
  spans, equal blocks and equal compiled functions are shared before a delivery
  codec destroys equality neighborhoods.  Compression and erasure shards are
  replaceable projections, not semantic identity.
- A static server that ignores HTTP Range must not force retention of the whole
  bundle.  Delivery can address independently fetchable shard objects; a `200`
  response to one coordinate is not a license to retain every cold coordinate.
- No product path calls `readAll` or `read(0, artifact.length)` for a machine,
  filesystem, compiler, or direct executable.  Native `WebAssembly.compile`
  receives one bounded emitted module at a time.

Gate: for a fixed hot boot trace, fetched and resident bytes are bounded by the
trace's unique pages/modules plus configured cache and dirty state, independent
of virtual RAM extent and unrelated cold toolchain contents.  Report logical,
unique, fetched, decoded, resident and dirty bytes separately.

The top-down growth contract is therefore:

| Layer | Canonical growth | Allowed opened/resident growth |
| --- | --- | --- |
| catalog/root selection | one authenticated root plus selected path | `O(log objects)` path nodes |
| executable directory | page/module identities and quotient-shared rows | root plus selected directory pages; never module payload bytes |
| sparse address space | `O(mapped pages)`, gap-coded; zero extents have no row | `O(log mapped pages)` lookup state plus touched pages |
| immutable filesystem | unique file/extent content and metadata | touched extents plus Linux's own bounded page/dentry caches |
| compiled code | unique quotient classes split into bounded Wasm modules | loaded hot modules plus a configured module cache |
| dirty state | one COW identity per changed physical page | current dirty working set and published snapshot root |

Unique content remains linear in its information.  What must not be linear is
the path used to select one piece, the metadata allocated merely because an
address exists, or the content admitted for a fixed trace.  For a trace `t`,
the product gate is:

```text
resident(t)
 <= root_path(t)
  + page_cache_limit * page_bytes
  + module_cache_limit
  + dirty_pages(t) * page_bytes

root_path(t) = O(log object_count + log mapped_page_count)
```

The current PGF wire already gap-codes mapped page coordinates, but its browser
opener used to expand them into a `pageCount`-long rank vector and allocate
three `uniquePages`-long cache vectors.  The opener now preserves sorted sparse
coordinates, resolves them by binary search, stores shard records sparsely, and
allocates cache metadata only for pending or resident ranks.  The next format
revision must also split the eagerly authenticated prefix into independently
authenticated directory pages; until then prefix bytes still grow linearly
with mapped and delivered shards even though payload residency is bounded.

The standalone C library now supplies that revision's primitive: `index.h`
stores sorted physical rows in authenticated leaves of at most 4 KiB and stores
only child digest, exact extent and key interval in branch nodes.  SHA-256 and
all key/range/canonicality checks run in C.  A lookup opens one root-to-leaf
path and rejects altered nodes, gaps, duplicate keys and overlapping children.
`postlink-executable-v2` is an exact 1,584-byte root containing the canonical
initial x86 cut and three fixed `pl_index_ref` values.  VM publication walks
only the selected authenticated binding/module/resource paths, hashes the
module as a bounded byte stream, and lets the verified module install itself
into the shared table.  A physical miss then walks the resource index in C;
one complete 4 KiB immutable object is hashed before it becomes resident, and
an absent row becomes the authenticated zero-default page without a payload
fetch.  JavaScript maps requested digests to opaque byte ranges; it does not
parse state, rows, pages or function names.  Cold module faults and a
persistent authenticated dirty-COW root still use this same request protocol;
they must not introduce a second execution path.

### 9. Proof and performance gates

- Differential fuzz x86 instruction families, blocks, conditional pairs,
  indirect domains, faults and interrupts against the unoptimized image.
- Run Linux boot plus x86, signal, futex, clone3, exec, timers, ptrace,
  pipe/IPC, mm, tty, seccomp and net tests from data artifacts; tests do not
  become delivery artifacts.
- Record source instructions retired, physical work/span, block-class hits,
  compiler admissions, barrier counts, page fetches, resident bytes and cold
  boot time.
- Target cold BusyBox shell in at most three seconds, with `missingBlock == 0`
  and no Python/JavaScript execution route.

## Current measured boundary

The old trace graph and STEP executor measurements are not product inputs and
have been removed from this contract. The current C product has two distinct
populations:

- the complete executable-coordinate semantic catalog, used only to reject an
  unclosed x86 meaning; and
- the finite native entry/successor closure, used to select emitted blocks.

The latter is derived from ordinary ELF `e_entry`, executable symbols and
static code relocations. It retains only two one-bit coordinate sets and a u32
work queue while compiling, orders boundaries with one linear bitset walk, and
discards each normalized block plan after charging its aggregate cost. None of
those structures is an output format. On the checked real-ELF fixture this is
47 boundaries over 72 source instructions, reducing static physical work
98 -> 71 and span 86 -> 50. All 47 blocks are selected into one compact native
extent; identity removal reduces emitted instructions 72 -> 67 and selected
bytes 252 -> 232. Standard static/dynamic ELF fixtures pass proof and execute
directly. Distribution publication remains red until preserved stateful source
x86 is replaced by selected physical-SSA bodies, every unsupported metadata
encoding and indirect target population is closed, and the complete fixed root passes
differential and paired native benchmarks.
