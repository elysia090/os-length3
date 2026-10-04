# Common software trap delivery — 2026-10-04

The [actual browser receipt](2026-10-04-software-interrupt-browser.json)
passes INT3 at `0xffffffff8140449f` and enters Linux's own vector-3 handler
at `0xffffffff810009a0`. The next grammar refusal is `pushq 40(%rsp)`
(`ff 74 24 28`) at `0xffffffff810009ad`. PID 1, shell and the complete
browser goal remain unachieved. The shipped native bundle and human UI are
unchanged. A diagnostic `status: pass` is not Linux boot success.

## Derivation and boundary

INT3 is a trap: its frame saves the next instruction coordinate, no error
code and RF=0. A fault instead saves the original coordinate and RF=1;
an external IRQ preserves RF. See [Intel SDM, exceptions](https://cdrdv2-public.intel.com/835754/253668-sdm-vol-3a.pdf)
and [Intel SDM, debug RF](https://cdrdv2-public.intel.com/858456/253669-088-sdm-vol-3b.pdf).
Advancing RIP/retirement before IDT delivery would incorrectly attribute an
IDT/GDT/stack fault to the following instruction. The emitted call therefore
supplies only a vector and return coordinate to the C machine boundary.
It does not supply instruction bytes or a host handler address.

The existing 168-byte frame frontier distinguishes fault, IRQ and software
events without growing. C owns descriptor validation and ordered frame
stores. During a residency wait, the CPU remains at the source instruction;
already-consumed descriptors and completed stores are not reread/replayed.
Only successful delivery publishes handler RIP/CS/RSP/flags, after which
generated code retires once. Dispatch returns conservative STALE after
frame writes; tests require an actual completed instruction, not STALE alone.
A fault call cannot destroy a pending software delivery. Pinned continuation
prevents rebind/IRQ admission during partial delivery.

This admission is CPL0 long mode, IST0, vector 3. INT n, ICEBP, HLT,
privilege/IST transition, full debug ordering and secondary double/triple
fault escalation are not claimed. Unsupported cases refuse explicitly.

## Red and independent comparisons

The old common compiler returned grammar/-102. The existing independent
system-mode exception oracle had 32 #BP observations, but both checkers
excluded them. The checkers now compare all 128 frames, generated IRETQ and
following-instruction RF behavior, including those 32 actual software traps.
A fresh QEMU TCG oracle run exits 33 through isa-debug-exit and yields
128 rows, SHA256 `6b31ee0177a93b454c81d3f6427ae84eeeb08578774752ea30756624c790b507`.
QEMU is an independent reference/build tool, not a product execution route
or a physical-CPU correctness guarantee.

Eight native-C/cold-C emissions are byte-identical. Separate architectural
models through the real C-Wasm IDT/MMU/frame provider check 1,024 complete
CPU/frame results, 64 waits/retries, 96 delivery faults and 56 entry refusals.
Native C tests add 64 software-frame models and an IDT/stack physical-alias
retry: completed stores overwrite the gate, but resumption uses the consumed
gate and does not replay them. These models are not relabeled as independent
system instruction observations. Full product checks, all linked VM-core
ASan/UBSan and scoped compiler sanitizers pass. Linked decoder/proof/support
archives in the scoped compiler check are ordinary builds. Previous FXSAVE,
FNINIT, UART and PIT comparisons remain green with the new binaries.

```sh
make -C src/v2/wasm-compiler software-interrupt-check
# Exclusive-write fixture output requires an existing fresh empty directory.
src/v2/wasm-compiler/build/software-interrupt-check NATIVE-DIRECTORY
node data/oracle/check-software-interrupt.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY
node data/oracle/check-exception.mjs VM.WASM COMPILER.WASM SYSTEM-FRAMES.txt
make -C src/v2 check
```

## Actual browser and costs

139,017,616 retired / 70,678,949 admissions, 796,998 modules, 5,437 Linux
console bytes and 509 IRQs. The trace explicitly records the source INT3
entering the guest handler; no opcode skip, kernel counter patch, manual
branch entry or function-specific return is used. Complete 14,622,864-byte
decompression remains SHA-identical. Calibration changes iteration counts;
they are neither boot percentages nor comparable speed samples.

```text
VM       60,752 bytes SHA256 630991f1652712b33402b2521c85b77799c703f9a7b1f09d1707322dbcaa83ac
compiler 434,740 bytes SHA256 7c6e38b2f458f10df0a95953efae1198cf6b3e418c27a4553490296d010d85ef
bundle SHA256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

Engine construction 81,519.1 ms, C execution 36,711.2, cold emission
25,078.9, admission 23,264.0 and supply 242.1 are diagnostic phase sums,
not cold-shell time. Source copying is 10,035,560,448 cumulative bytes,
not simultaneous memory. The 745 retained engine witnesses / 262,090
bytes are bounded byte witnesses, not engine RSS. VM memory is 18,874,368
bytes with 4,466 resident pages; compiler memory is 1,048,576. Transport
is 49 fetches / 3,154,432 fetched / 3,046,912 requested bytes with
65,536-byte cache high-water. Ordinary non-isolated Worker mode is tested;
no signed production admission or RSS reclamation measurement is claimed.
Cold shell three seconds remains unmet.
