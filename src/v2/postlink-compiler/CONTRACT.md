# Post-link compiler and VM contract

This is the acceptance contract and dependency order for the post-link
compiler.  A boot trace is test input; it is not the program being compiled.
The compiler's input is a linked x86 image plus its executable mappings.  Its
output is a directly callable VM executable bound to that unchanged source
identity.  STEP is internal build-side SSA evidence and must not become the
runtime instruction set.

## Acceptance contract

The command-line model is deliberately ordinary:

```text
cc source.c -o program
postlink-compiler program
vm program
```

The compiler attaches an authenticated executable projection without changing
the linked ELF bytes Linux maps, debugs and exposes through its VFS.  The Linux
product applies the same operation to the loaded kernel image and to each
executable ELF before it is published executable.  The browser does not own a
second executable loader, decoder, VFS, or interpreter.

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
- the artifact contains ordinary Wasm block modules, page-generation bindings
  and function ranks, not a boot-observed list of scalar STEP programs;
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
    (T(q), B(q), normalize(predicate(q), signature[n](S(q))))
```

until ranks stop changing.  This is the deterministic residual behaviour of
the block graph.

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

### 6. Emit a direct VM executable

- Lower each normalized transfer class to an ordinary Wasm function with the
  fixed `(i32 machine, i32 executable_context) -> i64 result` ABI.
- Emit a total page-dispatch projection for each executable page.  Its domain
  is the page-offset region and its storage is the quotient function-rank
  region.  Pages parameterize shared dispatch functions by access-map rank;
  no fixed block record is materialized per coordinate.
- Keep the linked x86 bytes as source identity.  Bind page digest and generation
  to artifact-local function ranks and Wasm module digests.
- Emit static successors as direct ranks and dynamic successors through the
  page dispatcher, without assembling an X86B/STEP record.
- Gate: direct VM execution and native execution agree with the original
  linked program over differential tests.

### 7. One direct VM runtime path

- Instantiate compiler-emitted Wasm modules against the VM's shared memory and
  function table.  JavaScript may orchestrate module instantiation but never
  executes, decodes or reconstructs guest instructions.
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
  filesystem extents by digest/generation.  It does not embed the canonical
  toolchain tar and the same SquashFS bytes again inside boot RAM.
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

## Current measured gaps

The shipped closure has 222,079 blocks.  Of 279,371 static control edges,
278,563 resolve, 808 have no block at the target coordinate, and 34,775 resolve
to a coordinate with several proof variants.  There are 13,066 blocks with a
dynamic dispatch.  `pl_trace_edges` additionally keeps only a block with one
static successor, so its composition population omits real conditional loops.

Exact residual partition refinement over the current graph stabilizes after 18
rounds at 205,287 classes: 16,792 block rows (7.6%) share a complete future
residual.  Of 70,359 conditionals, only 15 currently have equal successor
classes and disappear directly; 17,916 admit the complement-and-arm-swap
canonical spelling.  This bounds plain dispatch deduplication and shows that
the larger win must come from closing variants and composing static runs, not
from hashing RIPs differently.

A BusyBox boot retires about 35.1 million source x86 instructions but loads
about 11.3 million blocks: only 3.11 source instructions per block.  It enters
the STEP executor about 15.3 million times and executes 29.5 million STEP
nodes.  The immediate runtime cost is therefore block dispatch, state-shape
restore and memory retry; artifact fetch is not the dominant term.
