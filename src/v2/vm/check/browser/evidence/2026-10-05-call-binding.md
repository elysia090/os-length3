# Direct CALL topology and its residual displacement — 2026-10-05

## Actual dominant term

The completed frozen `f1cd38c` same-bundle diagnostic passed the user SYSCALL
gate and stops at unprefixed MOVSB `a4`, RIP `0x7f997650c1f2`, compiler
-102, after 187,420,592 retirements / 97,917,652 admissions.
The console announces `/init`; successful PID 1, immutable-root mount,
shell and browser acceptance remain unproved. See the
[exact completed receipt](2026-10-05-node-startup-movs-red.json).

Under the unchanged 1,024-entry / 262,144-byte quotas, engine construction
still dominates: 9,013,853 constructions / 9,013,111 evictions / 24,518,984
hits, 742 retained bodies / 261,954 bytes. Engine construction takes
335,947 ms, cold C emission 265,998 ms, C execution 79,089 ms, admission
23,943 ms, extent supply 844 ms; diagnostic elapsed time is 840,292 ms.
Different retired work and clock calibration prevent a paired speedup claim.
These binaries do NOT contain the CALL change below.

## Substitution and admission

For one admitted canonical direct rel32 CALL, let E be the source entry,
L its exact source length and b the signed destination displacement:

    F = E + L
    write64(old_RSP - 8, F) through the existing C MMU
    if successful:
        RSP' = old_RSP - 8
        RIP' = F + sign_extend_32(b)
        RF' = 0
        retired' = retired + 1

The destination displacement changes neither the return-address store nor
the stack fault/wait frontier. It therefore belongs to the existing ABI-3
scalar binding, not the emitted topology. Unsigned subtraction and an
explicit signed-32-bit range guard avoid host signed overflow.
The existing canonical-target admission is unchanged; this is NOT a claim
about noncanonical-target CALL fault publication.

The same internal control-displacement binding now serves direct branches
and direct CALLs. Indirect memory CALL retains its memory displacement;
loaded targets and RET remain literal or loaded as before. The 24-byte
source row, 80-byte report, VM binary and private C continuation do not grow.
Exact compiled-body equality does not grant source fetch admission.
There is no instruction callback, opcode reader or alternate guest executor.

## Counted red and green

The explicitly synthetic [red](2026-10-05-call-sharing-red.json) and
[green](2026-10-05-call-sharing-green.json) use the same 81 emissions:
three coordinates, nine signed-rel32 boundary values and prefixes none/67/48.
324 complete CPU/cache/RAM models, 162 stack-fault models and 81 unchanged
wrong-entry refusals pass. Binding mismatches fall 72 -> 0.
Exact bodies fall **18 -> 2** and retained witnesses **6,344 -> 710 bytes**.
The unchanged bounded owner constructs 18 -> 2 instances for 4,096 requests,
with no eviction or larger quota. Five-byte and six-byte CALL lengths remain
distinct because their return addresses differ.

The fresh independent native oracle executes 30 CALL forms (forward/backward,
three prefixes, two entry offsets, five sole-valid destinations) over 128
states each. It physically observes GPRs, flags and the exact eight return
bytes, and verifies all other stack bytes unchanged. The destination coordinate
is a construction annotation, not a captured hardware RIP/cache image.
30 byte-exact native-C/cold-C compiler comparisons and **7,680** direct/
actual C-dispatch native-derived comparisons pass.

Full native compiler/CLI checks and scoped GCC ASan/UBSan of the compiler and
CALL fixture pass; separately linked provider libraries are not sanitizer
instrumented. The existing entry/latch sweep also passes. The freshly
regenerated 11 stack attestations now explicitly carry the scalar binding;
5,632 native/test-boundary and 5,632 native/C-MMU comparisons plus 22
residency waits/retries pass. No missing scalar is guessed as zero.

Candidate compiler is 451,755 bytes (+153), SHA-256
`780aaa570ee07f159e55833af7b144ff171ba7bdcbfaccc6c750193d155f4826`.
VM stays 69,903 bytes. These are local oracles and synthetic sharing receipts,
not a Linux hot-frequency census, distribution-size result, global minimum
or real-browser acceptance.
