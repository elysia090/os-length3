# Borrowed source-owned execution cohort — 2026-10-05

## Red and required normal form

Before implementation, three real cold-C compiled rows (MOV RAX,1; CLC;
JMP back), held by the C source owner, cannot satisfy `vm_run(...,99)` after
binding the first row. It returns 6 after one cut: the separate one-row host
directory is the limitation, not absent source code or a decoder failure.
This is reproduced against the unchanged serial-absence VM.

For each new cut, the sufficient identity is:

```text
(generation, CPU/MMU context, entry, compiler limit,
 first physical offset, optional crossing-tail physical offset)
```

The existing source owner already holds that identity and a compiled table
rank. A second flat/sorted directory, payload image or per-cut host row is
not necessary. However, permission/residency must be admitted by the current
C MMU on EVERY cut: the identity alone does not cache permission. Writes
notify before mutation; context changes cannot be hidden by reopening.
An eligible IRQ must precede both row selection and opcode-fetch faults.
An old inhibition requires the one-instruction compiler key. A suspended
instruction retains its original row/slot by value, not a new projection.

This is an exact bounded admission normalization, not a proof of a global
Myhill–Nerode minimum or instruction/engine-cache identity by hash.

## Implementation, one dispatcher

`vm_sources_reuse` shares page validation and the existing bounded masked
physical-key lookup with cold `probe`. It lends a published owned row without
copying it. A miss/refusal changes neither metadata, pending cold admission
nor output; it cannot evict/reserve a slot. A crossing candidate is refreshed
only after exact tail admission. Physical-offset collisions are compared,
not inferred from the index. Successful demand uses the existing O(1) LRU.

The same `vm_execution_run` loop accepts a C row/fetch owner. The Wasm binder
recognizes an exact published source rank and attaches that owner; mismatched
rank metadata is rejected. Native trusted flat-directory tests use the same
core loop, not another interpreter. A warm miss returns the exact completed
prefix for normal cold compilation. It does not construct/execute a row.

There is one permission admission per warm page, not owner admission followed
by another duplicate fetch. DR7, original five-word CPU context, generation,
write revocation, source instruction count, shadow, fault and continuation
checks remain in the shared loop. C handles IRQ priority before the lookup.
There is no JS branch executor, source payload copy, sorted cohort, enlarged
cache quota, generation increment/history or new execution export/entry ABI.

## Validation and measured scope

* The behavioral red is green: actual C-MMU/source/cold-C/table execution,
  budgets 1..65,536, complete CPU state, partial cold miss, missing/NX/deferred
  code page, remapped identity, A-bit write revocation, noncontiguous crossing
  tail, self-overwriting stores, precise #DE, context/debug/generation/
  narrow-shadow refusal, console wait at a later cut, descriptor poisoning,
  exact duplicate acceptance and Memory growth/resume. See
  25 complete-state cases.
* The existing source regression still passes 536 real cold emissions,
  512 cold + 512 hot full-CPU comparisons, source aliases, both CMPXCHG arms,
  LOCK, crossing tails, private table slots and write/refusal frontiers.
  It exposed an intermediate regression: refusing a pending tail query
  masked the subsequent execution #PF. That refusal was removed, not the
  expected fault; the original assertion is unchanged and green.
* Actual C PIC/RTC IRQ + compiled STI/JMP, with all three initial shadow
  states, interrupts BEFORE an otherwise faulting unmapped successor RIP;
  exact retired prefix and saved five-word frame agree. Existing interrupt
  768 privilege/model transfers, 96 RTC IRQ entries, 32 PIT + 32 boundary
  entries and 3,200 pure-loop cuts remain green. No new system-mode hardware
  comparison is claimed.
* Native full C suite passes. Core dispatcher tests additionally prove one
  admission per cut, exact partial prefixes, context/DR7/write stops and all
  four latched barrier kinds. The source owner checks no mutation on warm
  miss/refusal/partial tail, preservation of a distinct cold pin, 4,096
  colliding physical owners and exact invalidation. Scoped source/execution
  ASan/UBSan pass; builds have no warnings.
* Entry-binding, active COM1, absent-I/O and source-admission regressions
  pass. Existing CPU/table/memory frontiers are not replaced with JS models.
* The same bundle/root-image short diagnostic with this VM passes the full
  independent 86-instruction CPU/hidden-cache witness, relocation/REP/BSS
  and shipped memset comparisons, then reaches its 1,000,000-admission quota
  at 1,617,931 retirements. Its existing one-cut supervisor is unchanged.
  See bounded prefix.
  Different virtual-clock measurements are not a matched Linux speed ratio.

Five paired Windows Node samples, same three actual compiled cuts, fixed
65,536 source retirements and equal complete final CPU state: median one-cut
query/bind/run path 21.391 ms; one C-owned cohort 7.615 ms. Supervisor run
calls fall from 65,536 to one. Compilation is outside this measurement,
clock events are absent and it is not a native x86/Linux/browser benchmark.
No Linux boot improvement or cold-shell claim follows from it.

Fresh VM: 65,271 bytes, SHA-256
`e663c8d83b4837c9fa7a2fc08d75a97e68a36fc710373f356de1ae2feb93f3ac`.
Compiler unchanged (446,940 bytes, ABI 2). Source capacity 64 and metadata
6,880 bytes / zero copied payload remain unchanged. This VM is NOT installed
into retained browser Workers or the independent running full-bundle job.

## Next obligation

The full-bundle diagnostic still requests one cut. Do not simply change its
budget: it assumes a barrier/fault retires zero and happens at the initially
admitted entry. Generalize committed-prefix accounting, fault entry/source
reporting, event continuation, engine demand hints and observation stops
before enabling bounded warm quanta after the startup proof checkpoints.
The source cache still misses and the engine still reconstructs excessively;
this change alone does not resolve the measured dominant construction term.
