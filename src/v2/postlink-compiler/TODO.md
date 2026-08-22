# What is left

The authoritative end-to-end task inventory is [CONTRACT.md](CONTRACT.md).
This file retains the detailed measurements and local implementation gaps that
feed that dependency order.

Ordered by what blocks what, with measurements where they exist. Every figure
here was measured on the shipped `artifact/linux-x86-64-postlink`, 222,079
blocks, unless it says otherwise.

## 0. The linked-image entrance is total; semantics are not

The new C frontend reads ordinary ELF64 or explicit raw executable maps and
uses a pinned decoder-only Zydis to preserve exact source-instruction cuts.
Linux executable sections living in writable `PT_LOAD` segments are included,
which is required for the physical kernel entry in `.init.text`.  Invalid,
overlong and truncated coordinates become #UD, #GP and instruction-fetch #PF
functions rather than absent blocks.  A total 4 KiB page projection assigns a
rank to holes and edge padding as well as mapped bytes.

Measured on the official Linux 7.1.8 `vmlinux`, including physical and virtual
aliases:

- 19,186,970 byte coordinates;
- 18,213,370 valid decodes and 982,408 fault functions;
- 991,154 direct edges, 950,556 currently targeting the projected image;
- 195,166 indirect edges;
- 799,118 conservative transfer classes after collision-proved alias sharing
  and separating terminal fault code proofs from their three fault transfers;
- 25,165,824 bytes of growable transfer workspace rather than the
  220,605,824-byte all-distinct capacity bound.

This is an entrance measurement, not semantic closure.  The 654 decoded
mnemonic kinds still need exact C SSA/QM lowering; direct edges outside the
current coordinate maps must be classified as a machine boundary, generation
variant or missing input before publication.  The old migration artifact is
useful parity evidence but cannot restore source cuts it already erased.

## 1. Conditional loop bodies are reachable

`pl_trace_backedges` now names every maximal straight-line run and retains a
conditional arm only when it returns from that run's tail to its head.  The
other arm remains the exit.  On the shipped artifact `postlink-compose --loops`
now finds **52** loop bodies rather than 3: 4 are single-block and the mean body
contains 4.65 blocks.

This closes the structural entrance hole.  It does not call the exit edge
fusible and it does not by itself claim that a body has a closed recurrence.

## 2. Persistent-cut recurrence proof

Requiring every architectural local to be unchanged or `slot + k` was stronger
than the observable contract.  An internal backedge needs only the least fixed
point containing memory/trap effects, the terminal predicate, and the
next-iteration outputs of every input those observations read.  Locals outside
that hot backward slice are materialized by the final ordinary iteration.
`pl_affine_analyse_cut` now constructs that fixed point rather than carrying a
full frame at every internal turn.

The affine grammar also follows selector-16 results after `X86_ALU` has fused
value and flags, and represents `base + index * scale + displacement` directly.
It therefore does not fall back to a scalar spelling merely because the main QM
pass already selected the stronger physical form.

Measured over the 52 real loop bodies:

- 3 are closed one-induction transactions;
- 7 have no advancing coordinate;
- 39 carry a genuinely non-affine value in the hot residual;
- 3 still have a non-affine address;
- none are refused as an unmodelled body.

The three closed cases are one 64-bit zero scan and two contiguous 64-bit
read/modify/write maps that clear a fixed bit while advancing an index.  They
are the next recurrence lowerings: a width-aware find transaction and a small
QM map kernel.  A checker that merely accepted the other 42 would be wrong;
their residual operation must first be given an exact closed form.

## 3. The main sweep

Two of the rewriter's stages are written as identity with the measurement that
justifies it, and the main sweep is not written at all.

| stage | lines | fires, of 299 composed pairs |
| --- | --- | --- |
| `_forward_memory_versions` | 190 | 0 |
| `_rewrite_relative_exchange` | 277 | 0 |
| the main sweep | ~800 | 27 |

The main sweep has 16 op-name branches; on this artifact it exercises two —
folding arithmetic and flags back into an `X86_ALU`, and coalescing adjacent
loads into a `load_region`. Both are the inverse of a pre-pass already written.

That count came from an op histogram, so it **undercounts**: a branch that
rewrites arguments without changing any op does not show up. Measure by
comparing whole graphs before writing the remaining branches off.

The two zero-firing stages are absent, not proven unnecessary. A parity that
ever needs them will disagree, which is the intended signal.

## 4. Removing the JavaScript fallback

`web/x86-machine.js` still holds a second, independent reader of the artifact.
Each of these has a C counterpart now, so the deletion is wiring rather than
new work:

| in `web/x86-machine.js` | replaced by |
| --- | --- |
| lines 432-459, validating 222,079 block rows, one BigInt per row | `pl_directory_open` |
| lines 460-472, a second pass building an 889,344-byte tail-byte CSR | nothing; `pl_directory_find` binary-searches the sorted rows |
| lines 839-848, the lookup through that CSR | `pl_directory_find` |
| `readCompactContinuation` | `pl_continuation_decode` |
| `assemble()`, RIP projection and X86B header synthesis | `pl_directory_admit` |
| `decodeState`, 16-char hex to BigInt per state word | not yet written |

Two full passes over 222,079 rows is roughly 444,000 BigInt allocations at open.

**Blocked on** where the bytes live. `vm.wasm` is `--initial-memory=33554432`,
32 MiB, and the descriptor and execution regions are 29,282,089 bytes against a
`MachineWorkspace` already over 23 MiB. Reuse the page-lease protocol vm.wasm
already has for physical memory (`vm_x86_physical_lease` /
`vm_x86_supply_physical`) for descriptor and execution pages, so `pl_directory`
runs over a bounded page cache and faults for what it needs. Do not raise the
initial memory to fit both regions.

Delete each JavaScript path as its C replacement lands. Never keep both.

## 5. Removing the Python fallback

`kernel/x86.py` is 22,122 lines and is a second, independent x86 implementation:
`X86DBT` decodes, forms blocks and closes them, and `X86Machine` is the host
boundary. `kernel/x86snapshot.py` is 3,326 more and writes the artifact.

The recurrence compiler is the sharpest case. `_counted_repeat_cut` and
`_collapse_repeat` have **no C counterpart** — `vm.c` only *executes* control 24
— so the thing that turns N dispatches into one `memory.copy` cannot run inside
the guest at all, which is the whole point of the port.

`_counted_repeat_cut` also requires the loop body to be exactly one block whose
boundary is a single-instruction counter update. It recognizes `dec %rcx; jnz`
and nothing else, which is why the shipped artifact contains **5** recurrence
instances. Port and generalize in one pass; generalizing the Python first only
grows what has to move.

`check/*_parity.py` are the exception: they exist to hold the C to the Python
while both exist, and they are deleted with it, not ported.

## 6. Making postlink-compiler a standalone distributable

The library boundary is now concrete: `Makefile` plus `include/` plus `src/`
builds `libpostlink.a` through `make library`, and the repository-only tools and
parity checks link that same archive without being part of the distribution.
`<postlink/postlink.h>` is the aggregate public include.

It builds with `gcc` and `ar` today, and `make guest` links statically
for the guest's own toolchain — but neither `make guest` nor `make wasm` has
been run on this development host, so both are declared rather than tested. A
host with `glibc.static` or the guest's musl would settle it.

What still ties it to the repository:

- `check/generate_opcodes.py` reads `qm.steppage` to generate
  `include/postlink/opcodes.h`. The generated header is checked in, so a
  distributable does not need Python — but regenerating it does, and `make
  parity` depends on it.
- every `check/*_parity.py` imports `kernel/` and `qm/`.
- the artifact format's other definitions still live in
  `kernel/x86snapshot.py` and `web/x86-machine.js`; `include/postlink/format.h`
  is the single definition only for what has been moved.

The distributable is `include/` plus `src/` plus the `Makefile`. Everything
under `check/` is repository scaffolding.

## 7. Schema 7: narrow the graph words

Measured over all 32,448 distinct templates: 311,987 node coordinates and 24,212
projection coordinates are stored in 8 bytes each, and **every one of them fits
in one byte and two respectively** — nothing wider anywhere. Recovering that is
2,329,181 bytes, 27.8% of the template region and 7.1% of the artifact.

A node coordinate indexes the block's own operand array, which is small by
construction, so this is a property of the encoding rather than of this kernel.
It survives composition too: no composed pair exceeds 255 nodes.

The machinery already exists — a canonical narrowest-width tag whose decode
rejects any non-minimal spelling, as `pl_continuation_encode` does. It is a
schema 7 repack over schema 6, the same artifact-to-artifact path
`postlink-repack` already takes, with no closure re-run.

## 8. The code proof cannot be shared

`code_identity.shared` is 0: all 222,079 proofs are distinct, 5,141,440 bytes,
because each guard entry carries its absolute address. Identical code at
different addresses never dedupes, and the bytes are a second copy of what
`regions.memory` already holds.

Making the proof address-relative would let it share, but it is what
`X86_CODE_MISMATCH` checks against, so it is also the invalidation mechanism an
emitting translator needs. Decide what the proof is for before compressing it.

## 9. The output is still interpreted

The pipeline is `linked x86 → normalized action → minimum physical
representative → direct VM executable → verification`, and the current path
stops at the normalized action: the migration artifact is interpreted as STEP
rather than emitted as direct Wasm functions. Measured at
about 3.4 x86 instructions per dispatch, that overhead is paid forever.

The lowering reference exists in `qm/isa.py` and `vm/emit.py`, but the product
path must be C.  `include/postlink/executable.h` fixes the direct block ABI and
page-generation/module container.  The freestanding C emitter now lowers
integer SSA, scalar loads/stores and contiguous load regions to ordinary
`(machine, context) -> result` Wasm functions.  Memory calls vm.wasm's MMU and
physical cache directly as Wasm imports; a cold page returns a delivery barrier
before architectural locals are published.  Its integration check generates a
1,904-byte four-function module whose two-function main chain resumes one
repeat and one memmove across three cold-page cuts, searches and reads the
copied row through physical operations, publishes three dirty COW pages, and
accounts a closed recurrence without dispatching its source loop.  Its second
block computes x86 ALU result and RFLAGS once, consumes the selector-16 value
projection directly, and executes multiply-high, insert, bit, byte-swap and
guarded divide lanes.  The third function proves divide-by-zero returns the
explicit #DE fault cut rather than a host Wasm trap.  A fixed residual vector
suppresses already completed memory effects when the block re-enters.  The
module imports the VM table and an immutable C-validated base, then installs
its own functions with an element segment.  The VM opens a 1,584-byte fixed
root whose canonical initial CPU state is applied in C, authenticates one
binding/module/resource path, streams and hashes the module through one 4 KiB
staging page, and only then publishes it.  Runtime physical misses walk the
same resource index in C; the test rejects a corrupted page, fetches exactly
the one overlaid page and materializes sparse holes as zero without a payload.
It also proves that an A -> B chain which cuts inside B resumes B rather than
replaying A.  No X86B, STEP or JavaScript row/state semantics participate.

The earlier migration snapshot admitted and decoded all 222,079 shipped blocks
through C and sent 517,452 concrete nodes through the production lowering.
Its old 211-node DIV/REM rejection is now obsolete: unsigned and signed
double-width division lower as one atomic physical result with an explicit
#DE predicate, and direct Wasm publishes neither quotient nor remainder before
that cut.  The full artifact must now be regenerated through the C frontend;
the remaining work is classified linked-image grammar, total page dispatch,
cold module loading and all-coordinate closure.  Python remains only a
temporary differential oracle until the regenerated C artifact agrees, then
is deleted.

The direct entry projection is now measured on the migration artifact.  Its
763 executable pages use 12,208 256-coordinate rows, of which 5,937 are
distinct (51.4% shared).  A dense four-byte function map is 12,500,992 bytes;
the two-level physical map is 6,103,904 bytes and its generated x86 and Wasm
hot paths both contain exactly two dependent indexed loads.  This is a shape
measurement only: unlisted coordinates in the boot-observed artifact currently
map to the fault rank, so the post-link compiler must repeat it over every
linked executable coordinate before publication.

## 10. Physical sharing is undone at the artifact boundary

The current catalog makes the failure visible.  Its five canonical identities
sum to 551,395,620 bytes: 324,997,120 toolchain, 117,954,710 boot machine,
75,532,134 compiler, 32,811,421 migration post-link image and 100,235 VM.
Preferred physical deliveries still sum to 278,886,601 bytes, even though the
boot image already contains the 114,573,312-byte SquashFS projection of the
toolchain.

The 64 KiB page quotient is applied after tar/SquashFS/Wasm serialization, where
equality has already been destroyed: toolchain has 4,959 unique pages of 4,960,
boot machine 1,800 of 1,800, migration image 501 of 501, and compiler module
1,153 of 1,153.  Deflate makes their wire bytes smaller but does not reduce the
opened identity or the number of distinct coordinates.

The concrete linear materializations are:

- `data/build.sh` publishes the canonical toolchain tar separately and also
  passes its SquashFS projection through `--physical-image`, copying those bytes
  into the boot-memory identity;
- `web/x86-machine.js` defaults to `backing.read(0, backing.length)`, rebuilding
  the complete migration artifact before parsing it;
- the schema-5 reader creates one JavaScript directory object per block and
  reconstructs X86B/STEP records; the shipped graph has 222,079 records;
- `PageBundle.readAll` allocates the complete canonical output, and a server
  returning `200` to a Range request retains the complete wire object in
  `source.full`;
- the browser compiler is one 75,532,134-byte Wasm module, so its native compile
  boundary reconstructs that whole module.

Top-down, the remaining linear terms are not equivalent:

- `artifact/index.json` is 1,436 bytes and linear only in the five catalog
  entries.  A content-addressed root path can make selection logarithmic, but
  this is not the 500 MiB problem.
- `artifact/toolchain/index.json` is 231,089 bytes because it repeats all 2,229
  filesystem entries outside Linux.  The build may use this list to validate
  completeness, but the runtime root must not publish it; the authenticated
  filesystem identity and Linux VFS are authoritative.
- the PGF manifest is correctly gap-coded on wire, but the browser expanded it
  to one rank slot per logical page and one cache/state/hot slot per unique
  page.  This was an open-time `O(logical pages + unique pages)` overconstraint.
  It now retains only sorted mapped coordinates and bounded resident Map
  entries.  On the checked-in native machine this changes 2,048 logical RAM
  coordinates into 141 mapped coordinates; only 111 page identities are
  distinct and at most 16 are resident under the inspected configuration.
- the current bundle prefix still contains every shard record and is therefore
  `O(mapped pages + delivered shards)`.  It is only 242,991 bytes for the
  325 MB toolchain today, but must become a digest-bound directory tree so one
  read holds `O(log N)` path nodes rather than the complete prefix.
- the immutable shard payload is necessarily linear in genuinely unique bytes.
  It becomes a memory defect only when `readAll`, `read(0, length)`, an ignored
  Range response, or an embedded physical image admits all of it for a trace
  that did not touch it.
- the direct executable root formerly appended every Wasm module payload.  It
  now contains only 192 header bytes, 72 bytes per page binding, 64 bytes per
  external module identity and 72 bytes per immutable memory identity; exact
  module and memory payloads are independently verified before publication.
  One sparse zero-default base row plus ordered read-only extent rows lets the
  SquashFS object stay external instead of being copied into post-link output.
- 222,079 X86B/STEP block records and the 75,532,134-byte monolithic compiler
  module remain linear runtime objects.  They disappear only when the C
  postlink compiler emits bounded ordinary Wasm modules and the VM consumes
  their function table directly.

The sparse 512 MiB guest address space itself is not a 512 MiB artifact: its
current boot identity is 117,954,710 bytes and vm.wasm keeps a bounded physical
cache.  Preserve that win.  Replace the remaining copies with a root of digest-
bound external extents, quotient before compression, independently loadable
compiled modules, and bounded rank/select directories.  Selection/directory
coordinates may grow logarithmically; genuinely unique file bytes still obey
their information lower bound and must remain cold rather than be materialized.

The checked-in migration image also names source identity
`65e295bf130206e695905b617fe985e659e07436cc34e02af3bfc72375f715ab`,
while the current boot artifact is
`b179f164b0a48a15c43b9e714595cbe3f5b03ccb7669099719b0deb0c216e58d`.
The direct executable loader must reject this drift before publication; it is
not a reason to keep two source images resident.
