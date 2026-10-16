# Shared far control transaction — 2026-10-09

The fixed make/every-final-PF_X-byte population improves 328 -> 237 missing:
233,218 of 233,455 coordinates lower. All 91 far call/jump coordinates are
recovered. Remaining x87 150, SIMD 86, atomic 1; first is DD32 at 0xd382.
This byte population is not an execution trace or whole-image publication.
Native release and human UI are unchanged.

The common x86 law validates FF /3 and /5, memory-only 4/6/10-byte far
pointers, operand/source/effect agreement, and precise control flow. The
compiler reads the exact pointer once and retains offset + selector+1 in the
existing two-word checkpoint. No instruction interpreter or second CPU image
is introduced. The C boundary uses the existing descriptor/MMU authorities
and 168-byte event frontier, including 64-bit call-gate inner stack changes.

The descriptor, optional gate high half, target descriptor, Accessed write,
optional TSS stack read and individual frame stores are ordered phases.
Completed stores and consumed descriptors survive residency waits; retries
cannot repeat them after aliasing writes. Architectural CPU publication occurs
only after success. Early invalid/stale inputs release the retained frontier
and any reservation rather than leaving an abandoned transaction.

Independent native observation exposed two important ordering differences:
code Accessed precedes a noncanonical target #GP; CALL's frame RAM writes also
precede that #GP, although RSP/CS/RIP remain old. The implementation was fixed,
not the native receipts. A second native bank covers conforming target code
and a first frame store followed by a page fault on the next store.

Verification:

- 384 common constructor forms / 6,144 malformed law controls.
- 241 C transaction cases / 1,395 state, gate, alias, wait and release checks.
- 384 independent WHPX frames match actual compiled Wasm/C VM execution:
  131 successful transfers and 253 faults, 12 generated modules. Target,
  RSP/CS/SS/flags, fault codes, descriptor Accessed and frame RAM are measured;
  declared hidden-cache/transport setup is not a native cache measurement.
- 3,456 compiled boundary models cover FS/GS/address32, exact cross-page
  pointers, source/descriptor/TSS/frame PF and waits; 984 waits/retries and
  984 PF results. Duplicate waits preserve CPU state and retirement is exact.
- Full C VM checks, 464 postlink semantic witnesses and positive ASan/UBSan
  gates pass. The old code-cut negative expectations for far transfers were
  replaced with control-boundary/extent assertions; invalid LOCK stays #UD.
  The separate intermittent near CALL native RAM-payload red is not erased.
- Same-bundle bounded startup retains the independent 86-cut checkpoint and
  1,617,931 retired / 703 modules at the unchanged 1M admission quota. This
  quota receipt does not certify PID1/shell, memory reclamation or cold3s.

Compatibility mode, CET, general debug/TF/AC and modes outside the current
CPU admission contract remain separate obligations, not implicit fallbacks.

ABI4 compiler 749,301 bytes, SHA256
`e4682647ffc43f9e67e0c3c8185266286c1bf6bc321df5f87fd3d9c0f849aa94`.
VM 102,433 bytes, SHA256
`2503bbcef80c6f634698e43ca1b62f9292f20ce3934166871212049d41523874`.

```sh
make -C src/v2/vm check
make -C src/v2/wasm-compiler far-transfer-check
as --32 --defsym far_transfer_oracle=1 data/oracle/iret-entry.S -o FAR.o
ld -m elf_i386 -T data/oracle/exception-entry.ld FAR.o -o FAR.elf
node data/oracle/check-iret-system.mjs QEMU.EXE FAR.elf NEW.LOG whpx --far-transfer
node data/oracle/check-far-transfer.mjs VM.WASM COMPILER.WASM NEW.LOG
node data/oracle/check-far-transfer-boundary.mjs VM.WASM COMPILER.WASM
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Continue common floating/SIMD/atomic closure and actual browser Linux, rather
than publishing an observed-only coordinate subset.
