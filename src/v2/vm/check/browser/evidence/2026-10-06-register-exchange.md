# Register exchange is simultaneous substitution — 2026-10-06

The completed `f30ac99` unchanged-bundle run passes FS TLS and reaches
`48 93` (XCHG RAX,RBX), RIP `0x7f60ac407401`, common compiler -102 after
180,839,787 retirements / 93,108,138 admissions. See the
[actual receipt](2026-10-06-node-startup-exchange-red.json). Engine construction
250,159 ms exceeds cold emission 217,728 ms and C execution 67,109 ms;
total 673,905 ms. The fixed 262,144-byte/1,024-entry owner retains 746 bodies /
262,093 witness bytes, with 6,272,897 constructions / 6,272,151 evictions.
Different retired work/active-execution clocks do not establish a speedup ratio.
The `/init` announcement still does not prove successful PID 1 or shell.

Before changing product lowering, the new native `exchange-check` fails at
form 0 with compiler -102. The ISA decoder already identifies register XCHG;
the common pure admission/lowering is what was missing. Memory XCHG was
already accepted through its separate serialized atomic/RMW transaction.
An initially incorrect test expectation that memory XCHG should refuse was
replaced by six explicit positive memory/LOCK/FS/GS admission checks. Invalid
LOCK-on-register refusals remain, with untouched source/output/report.

## Normal form and parent aliases

For two equal-width register fields A and B of the current SSA values:

    a = extract(original_parent_A, field_A)
    b = extract(original_parent_B, field_B)
    parent_A' = deposit(original_parent_A, field_A, b)
    parent_B' = deposit(current_parent_B, field_B, a)

Both inputs are captured before either write. The second deposit preserves
the already substituted other field when AL/AH share a parent. A 16/8-bit
write preserves all unrelated parent bits; a 32-bit write clears the upper
half, including ModRM self-exchange. Full-width exchange is only substitution,
not XOR/add/subtract arithmetic. No flags are written. The existing short
opcode's architectural NOP alias is kept as NOP, rather than incorrectly
zeroing RAX's high half. Preceding MOV values remain current SSA; no entry
state reload is introduced. Only ordinary final cut publication stores the
resulting registers/RIP/retirement. Memory exchange never enters this pure path.

## Counted evidence

[Green receipt](2026-10-06-register-exchange-green.json): 186 fresh native-C/
cold-Wasm-C byte-parity emissions; 11,904 actual x86 user-mode GPR/flag rows;
11,904 direct + 11,904 C-dispatch complete-state comparisons. The independent
reference build VM runs native instructions; this is not physical-hardware
evidence. Includes 8/16/32/64-bit fields, extended and high-byte registers,
self/short-form cases, preceding/following MOV and two-exchange composition.
The native CALL harness cannot safely overwrite its own live RSP. All 1,024
REX register-pair encodings, including those RSP writes, pass native compiler
admission; 1,088 separate complete-state substitution models execute through
the actual cold compiler/Wasm body, covering RSP and all legacy high-byte
aliases. Those explicit models are not counted as independent ISA observations.

746 entry/TF/alignment/overflow/stale/invalid-LOCK refusals and the shared
RF-retirement models pass. Full native compiler/CLI checks pass without new
warnings. Scoped GCC ASan/UBSan instruments the compiler and native exchange
fixture, not the separately linked x86/optimized-x86/support libraries.
The first sanitizer link mixed non-PIE archive objects with a PIE harness;
a fresh, consistently PIE-compatible sanitized build passes. No test was
silenced. FS/GS, non-REP strings and direct CALL regressions remain green.

Recipe: `make -C src/v2/wasm-compiler exchange-check`, then
`build/exchange-check NEW-DIRECTORY`; run `node data/oracle/check-exchange.mjs
VM.WASM COMPILER.WASM NEW-DIRECTORY` on those freshly emitted observations.

Compiler **452,445 bytes** (+277), SHA-256
`00f945bdef867808fbd8b3db933e28db134843b552093cf07f9dc70dede5581e`;
VM unchanged at 70,499 bytes. No new VM callback, entry ABI, row/report field,
quota or host guest interpreter. Native publication and human UI are unchanged.
This candidate is not in the completed `f30ac99` receipt. Re-run the same
authenticated bundle/segment fixture/immutable root to obtain its next actual
gate. PID 1, root mount, shell/tooling, real-browser acceptance and cold shell
3 seconds remain unachieved.

## Follow-up: reflexive substitution has no register work

For equal fields of the same parent, `a = b`, and the two deposits reduce to
identity for 8/16/64-bit writes. Eliminate the register reads/writes entirely,
but keep ordinary RIP/RF/retirement publication. The exception is a 32-bit
write: `parent' = parent & 0xffffffff` is not identity, so it remains emitted.
AL/AH are different fields even though they share a parent and are not removed.

The previous candidate fails the strict exact-body sharing assertion. With
`--observe` it still passes all semantics comparisons but explicitly reports
[identity-sharing-red](2026-10-06-exchange-identity-before.json), not green.
The same synthetic 56-field matrix is **56 bodies / 14,328 bytes -> 3 bodies /
612 bytes** after substitution. The three residual source lengths are 2/3/4;
each identity module is 204 bytes. This is exact topology-witness storage for
that matrix, not a measured Linux-frequency or release-size reduction.
[Fresh green](2026-10-06-exchange-identity-green.json) retains all 186 native/
cold parity emissions, 11,904 direct + 11,904 dispatch comparisons and 1,088
complete-state models. Fresh full native compiler/CLI and scoped ASan/UBSan
also pass without new warnings.

Compiler **452,486 bytes**, SHA-256
`eac50ba46948eb70c7aef1f5c30377a87c8364c052f3864a63893781d8d95cf2`;
VM unchanged. This later candidate is not loaded in the ongoing separately
frozen `5610a5f` same-bundle job (PID 15708, 452,445-byte compiler,
`temp/exchange-1006/frozen`, unchanged quotas/warmCuts=64). Do not overwrite its
binary or attribute its receipt to the later normalization.
