# Bounded physical source ownership — 2026-10-10

An actual browser run of the rebuilt official kernel/init/root reached
285143648 retired instructions, but still had no shell. Of166623476 source
queries,102210153 reserved a cold slot, with102210089 quota replacements.
Sampled misses were absent entries, not remapped owners or budget refusals.
The64-row owner was repeatedly evicting usable compiled coordinates. Engine
construction reuse did not remove source admission and host/table rebinding.

The same zero-copy source owner is now partitioned into32 banks of64 ranks.
One deterministic entry-coordinate projection selects a bank. Each bank keeps
the existing one-word lookup/watch sets, exact physical spans, budget predicate
and O(1) validated-demand replacement list. Functions and source payload are
not duplicated into this owner. Metadata is221464 bytes, bounded independently
of instruction retirement. This is a retention policy, not an ISA fallback or
a claim that different coordinates are semantically equivalent.

Physical writes first select candidate banks through a256-word physical-page
watch directory. A candidate bank still tests exact source-span intersection.
Bucket aliases and stale summary bits may cause extra checks but cannot confer
authority. A summary bit is cleared only when that bank's corresponding watch
set is empty. The active unpublished reservation is separately included.
Publication records both pages of a crossing instruction. Every current fetch
still uses C-MMU executable admission; remapping/context/permissions are not
cached in the bank choice. Equal-byte writes still revoke source ownership.

Within a compiled call the active bank cannot change. A disjoint data write
preserves its still-owned row; writes to other banks revoke their rows through
the same observer. The next cut selects its bank only after a fresh C-MMU
admission. Warm demand sets are32 bounded words and one touched-bank mask,
not an instruction history. Compiler replacement/reset closes all banks.

Native controls compare131072 physical invalidation sequences against the
deliberately slow all-bank observer, including wide writes and watcher aliases.
A1024-entry population has1024 initial misses and16384 warm hits; the original
64-row owner has16384 misses over those same warm demands. Existing100000
replacement/20000 LRU-write-reset, crossing and49152 MMU permission controls
also pass. Actual compiled FRNDINT complete-state comparisons30720 pass with
the banked C provider; these tests are not Linux acceptance.

The public generated-cut interval check was separately normalized. For
nonempty intervals, order their starts as l<=u. Disjointness plus bounds is
exactly `l+size(l)<=u && u+size(u)<=memory.size`; the lower bound follows.
Both u32 addresses are widened before addition. Alignment is checked jointly.
The actual emitted Wasm passes18790 cases against the original predicate,
including both orders, adjacency/overlap, unaligned and near-wrap pointers;
4550 refusals perform no import or mutation. Scalar/pair/checkpoint/extent
modules shrink359/456/648/2651 ->349/446/638/2641 bytes.196608 independent SSE
complete-state comparisons and30720 FRNDINT comparisons pass after this change.
These are exact checks and measured bytes, not a global minimum or speedup.

The paired browser fixture reserves independent private compiler storage at
524288; C VM arena minimum is335872. The ABI remains4 and guest RAM does not
alias either private lifetime. Human UI and the immutable native publication
are unchanged. At134085978 retired, the actual rebuilt-image browser run had
7974 source misses,54775 warm runs/2960635 warm completed cuts. This sample
does not establish paired cold-ready speed, offline shell, or final delivery.
