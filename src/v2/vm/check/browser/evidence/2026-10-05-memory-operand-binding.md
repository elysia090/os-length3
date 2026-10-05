# One relative-memory topology per scalar displacement — 2026-10-05

## Red and backward derivation

The ABI-3 full-bundle job from `47ba6f2` completed with its frozen 447,154-byte
compiler. It passed Linux entry and announced `Run /init as init process`, then
stopped at FXRSTOR64 grammar -102, 230,277,143 retirements. Engine construction
remained the largest term: 31,694,949 constructions / 938,657 ms. It does NOT
contain this general-memory change and is not PID 1 or browser acceptance.
The [full receipt](2026-10-05-node-startup-fxrstor-red.json) is retained exactly
(SHA-256 `2419c3f90a50d8b582ecdde021137f7bcc11bc4d71d79dceb93b44174e46a0d5`).
Different retired work and clock calibration prevent a speedup ratio.

The IP-relative quotient left GPR/RSP/indexed displacements inside each body.
The [strict red](2026-10-05-memory-operand-binding.json) expects the decoded
signed displacement but receives zero from the previous compiler. The old
generated body still implements the displacement as a literal: correctness of
that body does not satisfy the topology-sharing obligation.

To eliminate that duplication while retaining architectural observations,
hold operation, source length, register bindings, scale, width, segment,
flags and effect/fault ordering fixed. The explicit address is

    EA = truncate_w(B + I*S + sign_extend(d))

`B` is the old GPR value or the independently admitted `E + L` for RIP/EIP.
`I` and `S` remain part of the existing emitted register/index topology.
Substitute the decoded displacement by the already latched scalar argument:

    d = sign_extend_32(operand_binding)

Every disp8 value is exactly representable in disp32, including -128. Address32
truncation occurs AFTER extension/addition; incoming high GPR bits and aliasing
do not change that equality. Zero must use the same parameterized body rather
than create a separate zero-displacement topology.

For this substitution, the required conditions are: one isolated accepted
instruction, exactly ONE visible memory operand, IP base without an index or
GPR base with zero/GPR index, address width 32/64, and signed-32 representability.
Counting all memory operands prevents one eligible operand from accidentally
rebinding another operand's unrelated address. Absolute pointer literals, pure
LEA/multi-instruction slices and independent immediates remain unbound.

These conditions plus the unchanged source generation/context/MMU admission
and latched value suffice to preserve the same EA and following effect/fault
trace for every incoming state accepted by the existing compiler. To share one
body while the displacement varies, some immutable displacement binding must
remain: it is not generally derivable from GPRs, entry or future page contents.
No claim that these are the necessary conditions for every conceivable compiler
optimization, or a global minimum over the ISA, follows from this local proof.

The emitted operation is still fixed compiled code. There is no opcode reader,
runtime register-number dispatch, guest instruction decode or second VM path.
The C source row retains the actual binding, and the same table call/continuation
passes it by value. No VM ABI change, descriptor array or source payload is added.

## Counted result and verification

The controlled [old](2026-10-05-memory-sharing-red.json) /
[new](2026-10-05-memory-sharing-green.json) grid contains the same twelve
matched release RIP loads/stores plus 57 explicitly SYNTHETIC GPR/RSP/index/disp8
emissions. Synthetic coordinates are not relabeled as hot release observations.
Distinct exact bodies fall from 59 to 8; witness bytes from 21,115 to 2,833.
The unchanged bounded constructor makes 59 versus 8 instances for 4,096 requests.
No eviction occurs in either grid. Timing is recorded, not claimed as Linux,
native-x86 or browser execution speedup, and not a release-wide size ratio.

Compiler: 447,176 bytes, SHA-256
`bbde32bd66571c8d60fd31698951b298c44f7555a7897c7c5a0677584d829be2`;
22 bytes above the frozen IP-only compiler. VM remains 67,133 bytes,
SHA-256 `e6edc2bf393d55fb4d84c595db63d4b427f2446fc3774cce4b8d1ec5e6775cc7`.
Source row/report/64-row metadata remain 24 / 80 / 6,880 bytes.
The native release/bundle/kernel and human UI are unchanged.

[Full validation receipt](2026-10-05-memory-operand-binding.json):

* 1,188 actual cold emissions; 321 complete CPU/physical-image comparisons,
  321 executable-fetch faults, 225 data faults, 321 wrong-binding refusals,
  321 equal-code-write revocations; eleven families, three coordinates,
  signed extrema, address32/index and disp8 corners. The constructor retains
  eleven bodies / 3,887 bytes across this wider correctness matrix.
* 79 newly produced native postlinked x86 modules / 40,448 C-MMU/native
  comparisons, 2,048 independent protection faults, 42,496 RF checks,
  158 waits/retries and 768 readable-write faults. All native bodies and
  attestations exactly match the independent cold-Wasm C compiler.
* Fresh native compiler `check`/CLI rollback/non-closure passes. Fresh native
  PUSH/POP, ordinary CALL/JMP, table, FXSAVE, vector/scalar and system-segment
  bodies pass their C-Wasm tests. Table continuation/fence, source ownership,
  disjoint/PTE cohorts, IRQ/shadow, old table-type and latch regressions pass.
  Strict independent CALL provenance red and 48 known system-oracle differences
  are not waived by these passing tests.

Recipes remain `prepare-operand-cuts.sh` / `prepare-entry-cuts.sh` with explicit
fresh compiler builds. Add `--memory` to `check-operand-binding.mjs` and
`check-cut-operand-sharing.mjs`. The latter's `--observe` only reports a red;
without it, the old compiler fails the sharing assertion.

Next: retain the in-flight IP-only full receipt, then use a separately frozen
general-memory compiler for the same bundle/quotas. PID 1, root mount/shell,
cold shell 3 seconds and real-browser acceptance remain unachieved.
