# Physical span and startup frontier — 2026-10-10

## Same64-row walk table, better candidate coordinates

Low-six-page-bit selection collapsed all64-page-stride aliases into one slot.
Folded page coordinates retain all8 independent alias witnesses in the same64
rows. Identity/control/CPL/access and every ancestor still match exactly.
At250000 actual C accesses the old index has1 hit/249999 misses; the new index
has249993/7 initially,249999/1 afterwards. Alias-read median27.8959 ->16.7059ms
(ratio0.5989); ordinary read/write/cross-page ratios0.9917/0.9611/1.0111.
This is not a general40% speedup.1920 cached/fresh and49152 permission gates
remain green; no capacity, permission or guest profile changes.

## Homogeneous writes are one physical run

REP STOS was repeating permission/translation/import work for every word.
For a serialized single-vCPU lane, adjacent equal-word stores inside one page
have one physical geometry and value. The common `machine.access` contract
describes that run, not an x86 opcode or CPU snapshot. Word width1/2/4/8,
forward/reverse address, total bytes and pattern value determine the effect.
The generated instruction uses the SAME C provider. It chooses the minimum of
count, remaining256-element quantum and page end; crossing single words retain
the ordinary exact scalar transaction. Flags, RF, zero-count/32-bit parents,
quantum/fault frontiers and source ownership are unchanged.

One page alone is insufficient: a destination can alias its own paging
ancestors. The existing successful walk witness supplies those exact physical
words. Only bytes whose pattern would actually change an ancestor matter.
The provider stops immediately after the earliest such word, publishes the
completed-word count, and the next run rewalks before another store. Equal
ancestor bytes do not force a cut. This prevents a fused fill from running
through a #PF created by its own earlier store. Missing witnesses conservatively
bound the same geometric operation to one word; there is no ISA interpreter.
Capability bit2 distinguishes this completed-prefix contract from experimental
bit1. Startup and hot compiler replacement refuse incompatible contracts before
guest execution; the typed call ABI remains4.

4032 full-RAM/port scalar-equivalence cases pass, with widths/directions/page
edges/write protection/ROM/stale ports; a self-unmapping leaf-table red passes.
336 independent native STOS CPU/RAM receipts,8 native/cold byte comparisons,
144 continuation models,184 entry/stale refusals,66 partial/fault/miss cases,
2 code aliases and24 RF frontiers pass. Existing MOVS also passes336 receipts.
The independent Linux C suites plus VM/compiler ASan/UBSan pass with source
`9af0a64d933a0e7587bb04152a498c99349e970a4924399c3120c36c6ed6e29f`.
Fixtures preserve the old hardware data; `repeat-refresh-tool` re-emits only
modules with the product Makefile's current native C library before byte parity.

Same-provider `rep stosq`,512 words/instruction, two256-element quanta,
4096 instructions/sample,7 rounds: current/baseline median ratio0.03957.
Binding/reset overhead is included. The emitted module grows459 ->571 bytes;
this is execution-work reduction, not a module-size improvement or Linux claim.

## Preserve observations without per-cut host returns

The initial REP/BSS and all three memset observations remain single-cut.
Only after3040256 relocated bytes,98656 BSS bytes and131104 memset bytes are
verified can already owned C cuts run in a cohort. The ELF-header-read witness
is a memory instruction: no preceding pure slice can contain it. It has never
been published in this on-demand source owner, so its first encounter is a
cold admission and yields BEFORE execution. The full decompression comparison
therefore still runs. Linux's first entry is likewise not previously owned.
The default regression's warmCuts=1 remains unchanged. There are no inserted
opcodes, manually selected branches, injected output bytes or CPU restoration.

The independent Node receipt compares all
14622864 output bytes/3571 page digests and reaches Linux entry129057478 retired.
Its300000029-instruction quota is not a shell/root acceptance claim. Actual
browser reaches151694747 retired in58408ms; the preceding single-cut startup
run reached141086346 in227963ms. These are different checkpoints, not paired
cold-ready measurements.

The rebuilt kernel/init/root remains identical. CPU profile, clock semantics,
10000ms service deadlines and human UI remain unchanged. Profiled actual boot
now passes supervision initialization but times out during the subsequent
offline service transition. Production (no diagnostic counters) provider
`7b10e52904a293ffab489ba8b69157c2ff3bfb7acb3fc36d2e673c4c61062e4c`
passes the same native REP controls and is under actual-browser test.
Final compiler SHA256:
`d0e4862f5be434f031e309a11ff16ec495c0a401eaa7c967f1d650abee6d62ee`.
The fixed CPU contract does not advertise ERMS; do not change CPUID or deadlines
to disguise the remaining ordinary unrolled-store/loop work.
