# What is left

Ordered by what blocks what, with measurements where they exist. Every figure
here was measured on the shipped `artifact/linux-x86-64-postlink`, 222,079
blocks, unless it says otherwise.

## 1. Loop bodies are not reachable yet

`pl_trace_edges` records an edge only where a block has exactly **one** static
successor. A loop's last block ends in a conditional — the backedge and the
exit — so it has two, and the run never closes. `postlink-compose --loops` finds
**3** loop bodies in the whole artifact, all single-block, which is the symptom
rather than the truth.

So the 84,492 fusible edges and the "38.0% of boundaries" figure cover
**straight-line runs only**. The population the recurrence closure needs is
absent from them.

Fix: follow a conditional's taken edge back to a run's head and admit that as a
backedge, keeping the exit edge as the run's boundary. Until then
`pl_affine_analyse` is exercised against bodies that are not loops, and its
"affine in one induction variable: 24 of 84,454" says nothing about real loops.

## 2. The affinity condition is too strong

`pl_affine_analyse` requires every local slot to be unchanged or `slot + k`.
A real page-freeing body also updates a freelist head and a count, so it refuses
with "a slot changes some other way" — 78,202 of 84,454 bodies.

The condition recurrence actually needs is narrower and different: a contiguous
multiword transaction, which is what `X86_CONTROL_RECURRENCE` represents. Decide
which one is being argued before widening the checker; a checker that accepts
more is only useful if what it accepts is still safe to collapse. Getting this
wrong marks pages freed that never were.

`combine` also models only add and subtract. Anything else makes a value opaque,
which refuses rather than approximates — deliberately, but it does mean shifts
and multiplies in an address computation refuse a body that may well be affine.

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

It builds with `gcc` and nothing else today, and `make guest` links statically
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

## 9. The output is not x86

The pipeline is `semantics → quotient → normalized action → minimum physical
representative → verification`, and the post-link path stops at the normalized
action: the artifact is interpreted STEP rather than emitted code. Measured at
about 3.4 x86 instructions per dispatch, that overhead is paid forever.

The lowering exists — `qm/isa.py` carries x86-64, +BMI2, +PCLMUL, AVX2 and
wasm32 profiles and searches them under `span, work, L(z), rank`, and
`vm/emit.py` says it emits "bytes, C, wasm32 or x86". The small-kernel product
uses it; the whole-program path does not.
