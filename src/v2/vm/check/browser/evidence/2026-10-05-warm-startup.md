# Bounded warm execution across the startup frontier

The published bundle is unchanged: publication
`1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195`,
SHA-256 `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
The native release, root image, kernel bytes and human UI are not modified.
This is an independent Node/C-Wasm diagnostic, not real-browser acceptance.

## Completed one-cut observation

The frozen earlier VM (63,191 bytes, ABI 2) actually passes the former DX=2F9h
secondary-UART refusal. The kernel registers the 89,878,528-byte phram system
device, PF_INET6/PF_PACKET and microcode status. The console contains no PID 1,
release-root mount or shell success. The 150,000,000-admission quota stops it
at 247,245,398 retirements, RIP `0xffffffff810a7faa`. Independent full kernel
decompression agrees before ELF PT_LOAD moves. This is a quota stop, not an
unsupported-opcode finding or successful boot.

The [complete receipt](2026-10-05-node-startup-serial-quota.json) SHA-256 is
`f39698da6a9fc0b1c0a29eb5b89b25e78e41d8e0249ad7ec4789b9a232f88850`.
Engine construction is still the measured maximum: 52,860,225 constructions,
1,502,576 ms; cold emission 644,489 ms, C execution 252,847 ms, admission
43,583 ms, supply 744 ms; elapsed 2,676,904 ms. The unchanged bounded owner
retains 765 instances / 261,827 byte witnesses and records 52,859,460 evictions.
Source hits/misses are 71,495,327 / 78,504,673 at capacity 64, with 6,880 metadata
bytes and zero copied source payload. Allocated linear Memory is 22,085,632
bytes, not process RSS. Different clock calibration and retired work prohibit
comparing this elapsed time as a speed ratio to prior runs.

## Derivation: one irreversible prefix, not one assumed instruction

Let R be the supervisor's committed architectural retirement, c_j the C
dispatcher's completed cuts and r_j its source retirements for continuation j.
For one bounded quantum Q, the only valid accounting is

    C = sum(c_j),  P = sum(r_j),  remaining = Q - C
    0 <= C <= Q,  c_j <= r_j <= 1024*c_j
    guest.retired = R + P

A fault, IRQ or barrier can follow a nonzero successful prefix. It does not
undo P. A waiting instruction contributes zero until C commits it exactly
once; its original latched source entry survives descriptor mutation and
Memory growth. IRQ entry changes RIP/frame but contributes no retirement.
The failure coordinate is the current C RIP, not the initially admitted row.
`CutProgress` holds only the three bounded numbers needed for these equations,
reusing one object per serialized lane. It stores no CPU image or history.

Each `vm_run` reports its fully admitted source count and a 64-bit union of
source ranks. The union is an engine demand hint only: no bit proves a source
permission, table binding or successor. JS visits only set bits in two 32-bit
banks, including bits 31/63 despite signed i64 transport. C alone selects
the next source with current MMU/context/shadow/write/IRQ admission.

For a failed retained cut, `vm_run_source` borrows its exact original physical
owner(s) without another MMU walk, page supply, source lookup or demand refresh.
It preserves CPU and the precise fault/request. Invalid generation/target,
completed/missing/revoked/latched source or subsequent admission returns an
explicit unavailable result without output. Source bytes never come from
the initial row when a later row failed. There is no source reconstruction,
new interpreter or generated guest import of these observation APIs.

## Proof and lifetime boundaries

`--warm-cuts=1..64` is explicit; the default stays one. All preproof startup
cuts remain single. The independent 86-instruction full CPU/hidden-cache,
relocation, complete REP/BSS/memset and shipped decompression observations
are unchanged. Only after decompression AND the actual Linux-entry witness
does the diagnostic allow already-published C source rows to form a quantum.
No checkpoint restore, predecoded next-RIP list or host guest execution exists.
Cold compiler/source/engine quotas are unchanged; a warm cold miss yields to
the same ordinary C cold compiler. The observation lane does not deploy into
retained browser Workers or replace their staged assets.

## Reds and validation

* The old numeric trace silently represented 65,536 source retirements as
  zero. The new independent test reproduced this before implementation.
  A 32-bit counter fixes it: fixed payload 1,088 bytes, 100,000 appends,
  133 eager-reference comparisons, zero hot formatting or guest writes.
  Negative/fractional/overflow/nonfinite counts reject before history changes.
* [Actual C/cohort observations](2026-10-05-warm-cohort.json): 155 emissions,
  28 complete-state cases, 26 prefix and 31 demand checks, three exact failed
  physical source observations and 37 source refusals. Coverage includes
  later #DE, crossing #DE with noncontiguous owners, unknown-port failure,
  cold/remapped/NX/deferred source, write revocation, console latch, exact
  duplicate acceptance, grow/resume and a real 64-entry JMP cohort.
  The reported 69,772 retirements count only the original eight pure-budget
  cases, not all fault/benchmark cases.
* [C IRQ observations](2026-10-05-warm-irq.json): three STI/JMP/shadow cohorts
  take the IRQ before unmapped successor fetch and preserve exact prefix /
  five-word frame. The IRQ indication is not counted as guest retirement.
* Existing source-admission (536 emissions, 512 cold + 512 hot full-state),
  entry-binding, absent-I/O, active COM1 and interrupt regressions remain green.
  Builds have no warnings. No new independent hardware oracle is claimed.
* `check-cut-progress` passes 44 prefix/reset/refusal cases plus overflow;
  startup CLI rejects 14 malformed/ambiguous requests before opening inputs.
* The [same-bundle short prefix](2026-10-05-warm-startup-prefix.json) passes the
  original architectural proof stops at 1,617,931 retirements / 1,000,000
  admissions. Requested warm cuts are 64, but warmRuns is ZERO because this
  quota occurs before Linux entry. It proves no warm Linux activation/speedup.

Final VM: 66,258 bytes, SHA-256
`74b1c737ee16a8bad956db1ee487c65fcadd556c068e71a28a15bfd945e32eb6`.
The compiler is unchanged: 446,940 bytes, ABI 2, SHA-256
`ca7788b12f97b52cf3c44d13923d7edc66217c7c6a69141f5ad357496c7bd245`.
Boundary-fee microbenchmarks are not Linux or native ALU benchmarks. Neither
this implementation nor fixture pass establishes PID 1 or cold shell 3s.

Next: finish the same-bundle warm-64 full run, preserve exact gate/counters,
then address the remaining maximum construction/source-retention term and
any actual common ISA/MMU/device red. Boot and offline development commands,
authenticated workspace recovery, granted NIC and real browser remain open.
