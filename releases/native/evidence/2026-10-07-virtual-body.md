# Virtual emitted-body quotient — 2026-10-07

Baseline `3d9c7ba` shares exact bodies, but first admits and writes the whole
raw collection. Its independent C-Wasm capacity red is -103: 130 source
exports produce an exact 7,646-byte projection, yet cap 8,000 is refused
because the unshared population would take 30,614 bytes.

## Capacity and identity

For the one final typed-import mapping, let B_i be the emitter's byte word
and l_i its length. The identity is exactly

    i ~ j iff l_i = l_j and every byte of B_i = B_j.

No hash, source-opcode pattern, metadata or approximate semantic signature
is an equality authority. All emitted functions have the same entry type and
contain only typed IMPORT calls, not module-local indices needing relocation.
The interface has fewer than 128 imports, so its remapping does not change
the one-byte call-index width measured in preflight.

The representative is the first source ordinal in its class. Let U be the
number of classes. The code-section payload length is

    uleb_bytes(U) + sum(classes c, uleb_bytes(l_c) + l_c).

The complete object is the ordinary Wasm prefix with U function definitions
and N directly aliased source exports, these unique bodies, and the existing
optional source-metadata/witness section. Only this exact total T is compared
with the declared cap and target capacity. Lowering, sorted source entries,
immutable borrows and output/input nonaliasing are still required. There is
no sum of raw duplicate bodies in that capacity condition.

No public bytes or reports are written until that preflight completes. Unique
representatives are then emitted once in class order. Each source row retains
its own span/count/budget/binding. No raw output, compaction, metadata move or
obsolete output tail exists; bytes beyond T are untouched.

## One emitter, resumable construction

The initial fixed-window prototype exposed another bad term: replaying a
whole long body for every 512-byte window. A wrapped real decoder counts
4,224 calls for two equal 128-instruction cuts and rejects that approach.
That prototype is not the committed product path.

The existing measure/emit implementation now consumes ONE construction cursor:
prologue, each instruction's existing lowering, epilogue. It borrows the
original source and existing reverse flag frontier; only lowering state such
as the loaded-register mask survives. It retains no decoded-instruction
population, CPU snapshots or encoded program owner. This is a compiler
continuation, not a guest execution/interpreter interface.

Exact comparison holds two 512-byte windows and resumes the two cursors. A
large single ISA fragment can be replayed from its own saved frontier; the
preceding body is not revisited. Unequal fragment boundaries and zero-byte
fragments do not affect byte-word equality. Fragment replay is not claimed
minimum work. For fixed ISA lowering, fragment sizes are bounded independently
of pure-block instruction count, removing the growing-body quadratic term.
The counter now gives 208 / 1,664 for 16 / 128 instructions (13 per instruction).

Rank-only bottom-up merges collapse equal representatives during each merge.
There are O(N log N) descriptor operations/comparisons in the worst case and
N-1 comparisons for one repeated class, not all-pairs scans or repeated full
population comparisons at every level. The existing limits stay at 256
source exports / 64 KiB final object. The comparison still uses bounded
transient flag/cursor/rank storage; no whole-program memory-minimum is claimed.

## Actual receipt and limitations

Receipt. Native compiler and VM checks,
scoped ASan/UBSan, exact/short-cap refusals, late unlowered source, unchanged
report/output/tail checks, late-window differences and 1/2/3/127/129/255/256
rank boundaries pass. Distinct wide literals and 17 repeated classes stay
distinct. 130 FXSAVE functions now yield one body / 9,971 bytes; the old raw
population cannot fit 64 KiB.

The unchanged object identity is 7,646 bytes, SHA-256
`141ab95d499e8b6422313e0eb44e736f551eac19703760758a5d9e86f5f433c3`.
This turn removes a construction/admission defect; it does NOT count the
previous 30,614 -> 7,646 reduction again as new saved bytes.

101 alternating paired Node C-Wasm samples, after 20 warmups at the same
64 KiB cap, have median 0.8334 -> 1.1412 ms (ratio 1.3693). Short collection
generation is slower. This is not a native/Linux/browser execution benchmark,
timing CI gate, peak-RSS result or distribution-size claim. Minimum compile
work and global semantic/work/span quotient remain open.

780 complete native/C-MMU/table comparisons, the unchanged 64-row source
owner, zero compiler calls during reuse and crossing/stale/source-mutation/
budget/cancel controls pass. Fault/cohort regressions pass. The SAME published
bundle's short Node check preserves the 86-instruction independent checkpoint
and 1,617,931 retirements, then its one-million-admission quota. Not Linux
shell success; no new actual-browser run or renderer-crash fix is claimed.

Whole-ELF function production and page dispatch still explicitly return -104.
An observed-source fixture or partially covered page cannot replace that
complete production/authorization obligation. Authenticated production
residency, exact dirty/machine/device recovery and offline development plus
granted storage/network browser acceptance remain open. Native publication
and human UI are unchanged; cold shell three seconds remains unmet.

```text
make -C src/v2/wasm-compiler check
make -C src/v2/vm check
make -C src/v2/wasm-compiler segment-sanitizer-check
node data/oracle/check-quotient-cap.mjs COMPILER.wasm
node data/oracle/bench-quotient-cap.mjs OLD-COMPILER.wasm COMPILER.wasm
node data/oracle/check-source-module.mjs VM.wasm COMPILER.wasm NATIVE-FIXTURE CROSSING-FIXTURE
```
