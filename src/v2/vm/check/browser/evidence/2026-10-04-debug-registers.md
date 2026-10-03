# Common debug-register cut — 2026-10-04

The shipped bundle is unchanged. The real browser passes the previous
`MOV DR7,RAX` gate at `0xffffffff8103b125`, then Linux's DR6 initialization.
It retires 136,916,237 instructions / 69,219,910 demanded admissions without
manual branch entries. The next compiler -102 is `0f bd 55 18` at
`0xffffffff811223a7`, memory-source BSR EDX,[RBP+0x18]. PID 1/shell is still red.
The full independent decompression witness remains 14,622,864 bytes / 3,571
pages, SHA-256 `6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.

## Ownership and limits

MOV DR is compiled into the C `machine.debug` transfer, not a source interpreter.
The current fixed CPU profile has no CR4.DE/RTM. DR4/5 alias the existing DR6/7
words; their unused slots never become a second owner. DR0..3 contain arbitrary
64-bit linear comparison values, not memory accesses. DR6/7 high bits fault;
low status/control fields and fixed bits have an explicit representative.
The generated instruction owns destination GPR/RIP/RF/retirement. Failed
transfers publish none of these and abort outstanding memory reservations.

GD reports pending #DB and sets BD before the transfer. GD is kept until
exception entry; current #DB delivery refuses explicitly and remains open.
No claim of complete debugging is made. Any DR7 address-enable bit refuses
generated-code and C dispatcher admission before guest fetch/call, including
continuations and a prior instruction enabling DR7. Enabling configuration is
not silently treated as a working address breakpoint. TF remains refused.

## Red / green evidence

- 3,072 compiler entrances were red: 8 DR ranks, all 16 GPRs, both directions,
  ignored size prefixes and all ModRM.mod encodings. They are now green.
- 9,344 independent C models; 768 generated modules / 227,328 C-Wasm full-state
  comparisons, 768 separate C dispatcher runs and 10,752 refusal checks pass.
- 592 QEMU TCG CPL0 rows match defined fields, including 144 #GP and 16 #DB.
  Twelve reserved-bit representative observations differ; the comparison masks
  only reserved fields, never architectural status/control/address fields.
  This is a software oracle, not physical-hardware fault proof. Privilege/GD
  interaction is independently model-tested, not CPL3 system-oracle coverage.
- 973 native/cold C byte-identical emissions pass after regenerating native
  bundle prefixes with the new guard. An earlier comparison against old native
  emissions correctly failed (213 vs 195 bytes); no stale result was blessed.
- Full `make -C src/v2 -k -j2 check`, all linked VM core ASan/UBSan and selected
  lowering/library code-cut ASan/UBSan pass. The latter's linked decoder/support/
  proof archives are normal builds, not whole-TCB sanitizer coverage.

Reproduce: `make -C src/v2/wasm-compiler build/code-cut-check`, emit a new fixture
directory, build the C provider/compiler with `data/oracle/wasm-tools.ps1`, then
run `data/oracle/check-debug.mjs`. `prepare-debug.sh NEW-DIRECTORY` emits the
system fixture; run it under QEMU TCG with `-net none`, debugcon 0xe9 and
isa-debug-exit 0xf4. Require exit 33 and all 592 rows. Validate using
`check-debug-system.mjs VM.WASM CUT-DIRECTORY TRACE`. The trace SHA-256 is
`ac96b10a98beac0ed01717c9293d74c8f0e13d8641adadd68828b982cef0c37a`.
An initial ELF32 oracle used unsupported 64-bit table relocations; they were
replaced by bounded 32-bit code pointers before obtaining the complete trace.

## Physical work observation, not completion

49 ranges / 3,154,432 fetched bytes, 65,536 cache high-water; 4,402 resident
pages, 18,874,368 VM bytes and 1,048,576 cold compiler memory bytes. The exact
source cache remains 64 rows / 6,752 metadata bytes / zero payload copies.
67,974,535 source hits / 1,245,376 misses. Engine: 1,245,375 compilations,
64 retained modules / 25,204 bytes. 434,163,188 emitted and 5,101,322,240 copied
code bytes are cumulative work, not resident memory. Engine time 102,762.5 ms
dominates this diagnostic, but this is not a controlled speed benchmark or
cold-shell measurement. No boot percentage is inferred from retirement count.
Provider is 40,351 bytes; compiler 428,035 bytes. Their hashes are
`4a6fca3ebeb0b0399a8f87dbc995919b058600daeb663fa3ea9e7e8c5486d622` and
`029e2a4212d1431fa08e8f6fb62d938fd7c27991e80c010fbcbbf226f00dee45`.
The human UI/native release is unchanged; all browser artifacts are diagnostic.
