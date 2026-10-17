# Scalar memory compare/exchange — 2026-10-03

The full browser product goal remains active. The same published native bundle
must reach Linux/PID 1, offline shell and bundled development tools, then
authenticated storage/workspace recovery and granted virtual-NIC use. This
checkpoint is common compiler progress, not Linux boot. Native publication and
the human UI are unchanged; cold shell three seconds remains unmet.

## Common semantics and ownership

The former real refusal `4c 0f b1 4b 18` is closed by scalar memory CMPXCHG
at all four widths, with and without LOCK. The existing native typed atomic
descriptor and post-link proof are retained unchanged. This Wasm projection
specializes that descriptor to ordinary SSA plus existing C-MMU reserve/commit;
there is no runtime atomic-op callback, extra VM decoder or kernel-coordinate
handler. A tentative decoder reclassification broke native proof acceptance
and was reverted, rather than leaving a second native interpretation.

The accumulator and source/address aliases are captured before publication.
Flags compare the accumulator with the original destination. BOTH arms execute
a write cycle, including mismatch and equal-value writes. Memory commits before
the mismatch accumulator update, flags, RIP and retirement. A failed reserve or
commit publishes no CPU state. Dword success preserves RAX[63:32]; dword failure
zeroes it. Byte/word results preserve the parent outside their width.

LOCK is accepted only in the current ordinary, non-shared Wasm memory ABI:
one serialized Worker owner and synchronous reserve/commit, with no guest writer,
event or await between them. Both the actual provider and emitted module reject
shared memory at link time. This is NOT an SMP/shared-RAM or asynchronous lease
proof. Other atomic/pair forms and unsupported prefixes still refuse explicitly.

[Intel SDM Volume 2A](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf)
specifies the destination write cycle regardless of comparison result. Parent
rules and precise fault behavior are additionally checked against native x86,
not inferred from a simplified pseudocode assignment.

## Red then green

Eight ordinary acceptance assertions initially failed; after implementing them,
eight LOCK assertions failed before the ownership-constrained implementation.
32 ordinary linked -> optimized ELF -> verified proof fixtures now pass:

- 16,384 complete CPU/RAM comparisons against actual native execution.
- 14,848 native protection-fault comparisons and 31,232 RF checks.
- All four widths, half equal/half mismatch, boundary/random values, high-byte
  and accumulator/source/address aliases, SIB, address-size 32, SS, R12 and RIP.
- Equal/mismatch crossed with inaccessible/read-only protection, including
  split operands; faults leave CPU/flags/RIP and payload unchanged.

Native observations run inside the reference build VM, not physical hardware.
These broad comparisons invoke generated cuts through C-MMU directly; they are
not separate table-dispatch or exception-entry completeness evidence. The source
owner test separately performs four actual cold CMPXCHG compilations and C
dispatcher executions (LOCK/no-LOCK x equal/mismatch), whose operand aliases
instruction bytes. Even an equal-byte mismatch write cancels source reuse,
retires exactly once and fences subsequent dispatch. Including previous source
regressions, the driver performs 14 actual cold compile/install operations.

Full product checks, 370 byte-identical native/cold C-Wasm emissions and selected
compiler/lowering ASan/UBSan pass, with no warning or sanitizer diagnostic in
the captured runs. Linked decoder/provider/support archives in the selected
sanitizer run are normal builds, not whole-TCB sanitizer coverage.

```sh
data/oracle/prepare-memory-exchange-cuts.sh NEW-DIRECTORY
node data/oracle/check-wasm-provider.mjs VM.WASM NEW-DIRECTORY
node data/oracle/check-source-admission.mjs VM.WASM COMPILER.WASM
make -C src/v2 -j2 check
```

## Actual browser

Visible bounded receipt: the ordinary
memory Worker executes 129,078,646 source instructions / 64,428,968 admissions,
64 live slots and no manually supplied branch entries. All 14,622,864 output
bytes / 3,571 pages still match independent gzip-validated page hashes before
guest PT_LOAD moves. Six observed #PFs and one #GP enter Linux's own handlers.
Instruction/fault counts are not boot percentages or completeness proofs.

The next unretired `-102` is `0f 94 44 24 2e` at `0xffffffff81096421`:
`SETE byte ptr [RSP+0x2e]`. Close common memory SETcc for all conditions with
native fault/flag observations; do not patch Linux or skip the instruction.
PID 1/shell and development/storage/network acceptance remain red.

Resources: 3,674 supplies / 3,687 resident pages; VM memory 15,728,640 bytes,
cold compiler 1,048,576. Source cache retains 64 rows / 6,752 metadata bytes /
zero payload copies, 64,056,263 hits / 372,706 misses. Engine cache retains 64
instances / 20,293 module bytes, 372,705 compilations and zero body hits.
Largest observed buckets: engine 35,241.5 ms, execution 31,054.7 ms, source
admission 20,416.3 ms, cold construction 6,076.7 ms. This single observation is
not a controlled speed comparison or cold-ready time. Cumulative emitted bytes
(130,626,126) and code-copy bytes (1,526,620,160) are work, not resident sizes.

Object transport: 47 ranges / 3,056,640 fetched bytes / 65,536 cache bytes,
excluding diagnostic fixture/module/output-hash requests. Local diagnostic
hashes do not establish signed-root/AEAD/ECC production admission. Native
bundle remains 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
Unchanged VM: 31,653 bytes, SHA-256
`cf42f4c9d83338c534c4eec5ddff389f5d5b9cca5b8f0b318077f02839675f4e`.
Compiler: 418,100 bytes, SHA-256
`3646beed249950ec1d852b99d17c10ca9e1d612b997d896b46c79ca94e57d836`.
