# Exact physical write frontier for owned execution

This is a refinement of the existing C dispatcher/source owner, not a second
interpreter or storage representation. The native release and browser/human
UI are unchanged. The independently running warm-64 Linux job uses the frozen
previous VM from checkpoint `2f94b2d`; this change is NOT loaded into it.

## Red and derivation

The existing source owner already observes physical writes before mutation,
invalidates every overlapping retained executable extent (even equal-value
writes), and checks both physical owners of a crossing instruction. Nevertheless
the Wasm provider revoked its whole execution admission after EVERY RAM write.
A data-only store therefore stopped a C-owned quantum after two cuts despite
having untouched, already compiled successors. The new exact assertion failed
with result 5 instead of result 1 before the change.

Let S be the union of all currently retained executable byte extents and W the
physical write set of one serialized memory effect. Let V be the 64-bit valid
rank set immediately before that effect. No guest import or concurrent host
writer can publish/reuse a rank during the effect. The observer only removes
ranks, and removes a rank exactly when its executable extent intersects W.
Therefore, in this API contract,

    V_after = V_before  <=>  W intersects no retained executable extent

This is an exact non-interference condition, not a hash, page-disjointness
guess, timestamp or cache-hit heuristic. Same-page writes outside a source
span are allowed. Equal-byte writes inside a source span are still fenced.
No second write-set scan, history, source payload or CPU frame is stored:
one ephemeral 64-bit value substitutes the already-observed physical effect.

Retention additionally requires an active C-owned row, unchanged admitted
generation and no latched continuation. Explicit flat-directory fixtures and
resumed instructions keep the original coarse write fence. No stale generation
can be resurrected. The successor is NOT admitted by the equality: the same
C selector must freshly check original CPU context, CS mode/shadow, IRQ priority,
MMU permissions/residency and exact physical source identity before invoking it.
Page-table writes outside S may change every translation; the next fetch still
sees the new mapping. CPU/control/MSR/exception boundaries remain explicit.
Source-fetch A/D writes retain their existing conservative frontier.

The common scalar access, reservation/commit, pair and bounded multiword
write APIs share `after_guest_write`; no alternative guest execution route is
introduced. Code and page-table aliases cannot be assumed absent. The contract
is one serialized lane, not concurrent DMA/SMP or an untrusted table attestation.

QEMU's [translator documentation](https://www.qemu.org/docs/master/devel/tcg.html)
also separates physical code invalidation from block dispatch and constrains
chaining when mappings can change. This implementation does not integrate its
engine: every owned successor still passes the C MMU rather than trusting a
patched direct jump across a mapping change.

## Actual C-Wasm validation

The [receipt](2026-10-05-disjoint-write-cohort.json) has 231 actual emissions,
42 complete-state cases, 40 prefix checks, 45 demand checks, four precise source
observations and 46 refusals. Its 69,772-retirement field counts only the original
eight pure-budget cases, not the new memory/benchmark cases.

* Scalar store loops consume budgets 4/31/64/4,096 without a host fence while
  retaining exact CPU/data/flag/retirement outcomes.
* Reserved INC memory RMW loops consume the same budgets, preserve incoming
  carry and produce exact arithmetic flags/data. No synthetic completion occurs.
* A write to the actual PTE precedes a cached successor: nonpresent and NX fault
  at that successor with the exact #PF payload; a physical remap yields a cold
  miss instead of executing the old function. Successful prefix stays committed.
* MOVDQU data stores consume a 64-cut quantum. A vector write over retained
  code still retires once and returns the write fence. A cross-page destination
  fault changes neither CPU nor the first fragment; it preserves the exact
  source/fault observation. No guest bytes are copied into another execution VM.
* Existing source aliases, equal-value CMPXCHG on both arms/LOCK, SETcc/BTS,
  A-bit code aliases, context/debug/generation/permission/missing-page,
  console latch, duplicate acceptance, Memory growth and IRQ ordering stay green.
  The old POP-to-+128 same-page test already proved source reuse (query result 0)
  but required a coarse execution fence: only that disjoint result is corrected;
  actual code-overlap assertions and all CPU/RAM observations are unchanged.
* Source-admission (536 emissions, 512 cold + 512 hot full-state comparisons),
  entry-binding, absent-I/O, active COM1, interrupt, exact engine owner and
  numeric/prefix regressions pass. The build has no warnings. Native core write
  observation/dispatcher logic is unchanged; no new hardware or sanitizer
  observation is claimed for this Wasm wrapper refinement.

Five fixed Windows Node samples use identical real bodies, 4,096 source
retirements and complete CPU/data equality. The one-cut reference follows the
C-produced RIP without decoding it. Calls decrease from 4,096 to 64; median
2.2263 ms -> 0.6657 ms. Cold compilation is outside the samples; host load is
concurrent and there is no timing gate or native/Linux/browser speedup claim.

The [same-bundle short prefix](2026-10-05-disjoint-write-prefix.json) retains all
independent CPU/hidden-cache/relocation/REP/BSS/memset witnesses at 1,617,931
retirements / 1,000,000 admissions. WarmRuns is zero before Linux entry: this
is not full Linux activation or boot acceptance.

VM: 67,106 bytes, SHA-256
`978d028a0bf50e3d2a88a2e9c483ba807552e05c8096182be5ee4c7a3f178fb6`.
Compiler unchanged: 446,940 bytes / machine-entry ABI 2. Source capacity 64,
6,880 metadata bytes and zero source payload copy are unchanged. The added
848 VM bytes are counted, not called compression. No retained browser Worker
or staged binary is replaced. After the frozen job completes, measure this
candidate on the same bundle; maximum engine/source reconstruction, PID 1,
offline development tools, recovery, granted NIC and browser acceptance remain.
