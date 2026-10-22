# One direct-branch topology per admitted displacement — 2026-10-05

## Measured problem and local normal form

The completed frozen `775fe27` same-bundle job stops at IRETQ execution refusal
6, RIP `0xffffffff81000b7e`, `48 cf`, after 214,809,102 retirements and
117,257,400 admissions. It announces `Run /init as init process`; this is not
successful PID 1 or shell. Its unchanged 256 KiB owner performs 18,325,526
constructions / 18,324,762 evictions, with 34,552,626 hits. Construction takes
620,365 ms, cold emission 421,736 ms, execution 131,046 ms, admission 32,895 ms
and supply 1,188 ms; total independent diagnostic 1,394,547 ms. Linear Memory
is 22,609,920 bytes, not RSS. This job contains memory sharing and FXRSTOR,
NOT the branch change below. Counts/clock calibration differ from the earlier
FXRSTOR gate, so these are not an elapsed-time speedup ratio.
See exact completed receipt.

The branch-sharing red has correct emitted
CPU behavior but embeds each direct destination displacement in a different
body. It uses a deliberately synthetic grid, not a Linux hot-frequency census.
An accepted pure cut contains at most one branch, at its end; preceding
possibly faulting transfers are already cut separately. Let `P` be the prefix,
`E` its separately admitted entry, `L` the complete source span, `d` the signed
rel8/rel32 displacement and `C` the branch predicate on the state after `P`:

    S' = P(S)
    F  = E + L
    RIP' = C(S') ? F + sign_extend_32(b) : F
    b = uint32(d)

For an unconditional branch `C = true`. All rel8 values, including -128, fit
exactly in rel32. Addition is modulo 2^64; unsigned subtraction obtains `d`
without signed overflow at high kernel coordinates. The original decoder,
canonical-target/profile checks, complete fetch admission and fault/IRQ ordering
remain in force. Target-page fetch is a subsequent admission, not speculative
execution or verification of that target at this branch.

Hold prefix topology/literals, source length, register/flag bindings and branch
condition fixed. Substitution of the exact latched `b` suffices for every state
admitted by that existing contract. Some displacement information must remain
when destinations differ; it cannot generally be recovered from GPRs or current
RIP. Different `(body, binding)` pairs are NOT equivalent unconditionally.
This is shared compiled topology with a residual scalar, not a complete-future
quotient of arbitrary x86 or a global ISA work/span minimum.

The existing ABI-3 i32 argument, 24-byte source row and 80-byte report carry the
value. The internal binding kind distinguishes the one isolated memory address
from the final branch: a preceding LEA keeps its own literal displacement.
No opcode, instruction reader, runtime register dispatch or second interpreter
is introduced. Literal immediates, loaded indirect targets and direct CALLs
remain unchanged. Zero uses the same parameterized branch body as nonzero.
The C owner compares the complete row, and its existing pinned continuation
retains entry/binding by value. Same-body reuse never grants source admission.

## Counted result and acceptance scope

The green repeats exactly 585 emissions
over 21 shapes, three coordinates and signed rel8/rel32 boundary values.
It includes all sixteen conditions, a literal LEA prefix, a CMP prefix, every
CF/PF/ZF/SF/OF combination, RF and retirement wrap. Distinct byte-exact bodies
fall **195 -> 21**, retained witnesses **44,888 -> 4,881 bytes**. The unchanged
bounded constructor builds 195 versus 21 instances for 4,096 requests, without
eviction or larger quotas. These are synthetic witnesses, not distribution
bytes or Linux/browser/native execution speedup. 37,440 complete state/window
models and 1,170 unchanged entry/TF refusals pass.

An explicit fresh native recipe builds normal linked ELF, applies the normal
postlink compiler and proof verifier, then observes native x86 and emits C
Wasm. All 17 branches, three prefixes (none/LEA/CMP) and two branch distances
produce 102 modules. 52,224 direct and 52,224 actual C table-dispatch comparisons
pass, plus 102 byte-exact native-C/cold-Wasm compiler parity checks. Native
records contain the scalar attestation; zero is not a compatibility default.
Changing this test transport does not change the guest branch expectation.

The expanded C-MMU entry sweep has 11 templates / 55 whole CPU/RAM comparisons,
55 wrong-entry and 55 fetch faults, five divide faults, ten pinned continuations
and two old-type refusals. Source/cohort, memory binding, IRQ/shadow/PIT and exact
bounded engine-owner checks pass. Fresh full C/CLI checks and the scoped
ASan/UBSan code-cut sweep pass. These are separate models/oracles, not browser
acceptance or full ISA/MMU closure.

A same-bundle short prefix reaches 1,617,931 retirements / 1,000,000 admissions,
742 constructions, unchanged native checkpoints at 86/1,264 retirements and
7,340,032-byte Memory. It has no Linux entry or warm execution; no global timing
claim follows. Compiler is 450,892 bytes (+111), SHA-256
`b235e3ec3ac39db29b87acc545ea07b17c0bf3011b24e985c456c74811dd4bb6`.
VM stays 67,944 bytes, source metadata 6,880 bytes / 64 rows. Native bundle,
kernel, release root and human UI stay unchanged. Browser assets/Workers are
not replaced by these independent diagnostics.

## Reproduce

```sh
node data/oracle/check-branch-sharing.mjs COMPILER.WASM
# Observation alone retains the old compiler's sharing red:
node data/oracle/check-branch-sharing.mjs OLD-COMPILER.WASM --observe
bash data/oracle/prepare-branch-cuts.sh NEW-DIRECTORY FRESH-COMPILER-BUILD
node data/oracle/check-wasm-cuts.mjs NEW-DIRECTORY COMPILER.WASM
node data/oracle/check-wasm-dispatch.mjs VM.WASM NEW-DIRECTORY
node data/oracle/check-entry-binding.mjs VM.WASM COMPILER.WASM
node data/oracle/check-interrupt-provider.mjs VM.WASM COMPILER.WASM
```

Next blocker: turn the real outer-IRET refusal into an independently observed
privilege/descriptor/frame/flags red. Do not skip the instruction, weaken a
permission check, count `/init` announcement as execution, or waive the separate
strict CALL fault-provenance red. PID 1, release-root mount, offline shell/tooling,
cold shell 3 seconds and real-browser acceptance remain unachieved.
