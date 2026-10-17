# Exact secondary-UART absence — 2026-10-05

The completed unchanged-bundle run
passes port 87h and reaches `IN AL, DX` (`ec`) at `ffffffff81263891h`,
DX=2F9h. Result 6, completed=retired=0: cold decoding/emission succeeds,
but the fixed C bus has no response for the second legacy UART. Retained
fault/request fields are stale, not a newly raised #GP or clock request.
Raw JSON SHA-256: `c2c8e54364885c54b295d27b5c348e110ab1931568112bd304685c622d10e24b`.

The actual locked Linux 7.2.7 source archive was read, not an unrelated
System.map: `drivers/tty/serial/8250/8250_port.c`, `autoconfig`, probes
IER by read/write-zero/read/write-15/read/restore, comparing the low nibble.
An absent range returns ffh even after writes, so this test fails normally.
The [official source](https://github.com/torvalds/linux/blob/master/drivers/tty/serial/8250/8250_port.c)
describes that existence test and ISA floating-bus precautions. This is a
platform contract, not a claim of physical-silicon or QEMU system parity.

## One bus rule, no phantom UART

Only COM1, 3F8h-3FFh, is wired to the existing C UART/IRQ4/console owner.
COM2-4 are absent. There are no additional scratch/divisor/IER/FIFO/IRQ or
output objects. The same existing absence branch handles both the exact
DMA set and these three ranges:

```text
S_uart = [2E8h,2EFh] union [2F8h,2FFh] union [3E8h,3EFh]
read8(p) = ffh                         p in S_uart
write8(p, x): all_device_state' = all_device_state
```

Mode, generation, CPL/IOPL and TSS bitmap checks precede the bus response.
Source fetch/#PF, TSS crossing-page wait/#PF and pending clock/console
tickets retain their priority. Unknown neighbors and 16/32-bit transfers
still refuse. Generated code alone publishes AL, RIP, RF and retirement.
No Linux probe/initcall or instruction is skipped. No interpreter is added.

## Red and scope of green

The expanded native matrix fails 30,300 assertions before the change;
the same cold-generated check fails with actual 6 / expected 1. Afterwards:

* Full native C VM suite: 49,152 absent-device matrix transfers, 8,192
  uninterrupted write/read sequences, the Linux IER probe, retained COM1
  scratch/IRQ state, existing 7,680 permission cases and edge/fault checks pass.
* C-Wasm: 574 emissions, 15,362 full-CPU comparisons,
  4,162 matrix retirements, 2,880 permission faults, 8,320 width refusals,
  480 each source-fetch/stale-generation/wrong-binding/pending-clock refusals,
  28 unknown-neighbor refusals and 8,192 two-instruction sequences pass.
* Active COM1 C-Wasm regression: 7,466 comparisons, FIFO/privilege/console
  ticket/duplicate/cancel behavior remains green. Fresh native/cold I/O parity
  (26 forms, 3,328 event/frontier cases), admitted-coordinate/C-MMU regressions
  and scoped I/O ASan/UBSan pass. No build warnings.

Fresh VM: 63,191 bytes (+26), SHA-256
`6902d5843d76c447144ac3c0102ca3be08ca33b9138c9f26993e5469e215b3ef`.
Compiler remains 446,940 bytes / `ca7788b12f97b52cf3c44d13923d7edc66217c7c6a69141f5ad357496c7bd245`.
Native bundle, UI and staged/retained browser binaries are unchanged.
These tests are not browser acceptance, PID 1, shell or a full-bundle pass.

## Completed measurement and remaining maximum term

214,024,756 retired source instructions / 124,957,500 admissions, identical
complete decompression, initramfs unpacking, CRNG ready, SquashFS registration
and ttyS0 discovery are observed. PID 1/root mount/shell are unachieved.

Elapsed diagnostic time 1,938,090.752 ms (32.3 minutes); cold C 462,900.390 ms,
engine construction 1,070,383.764 ms, C execution 183,278.541 ms, admission
35,601.822 ms, supply 731.325 ms. Engine constructions 34,933,372, evictions
34,932,598, hits 19,286,417, 774 live witnesses / 261,995 bytes under unchanged
quotas. Source owner: 70,737,711 hits / 54,219,789 misses, capacity 64,
metadata 6,880 bytes, zero copied payload. Allocated linear Memory 21,561,344
bytes is not RSS. This run has different guest clock calibration and retired
work: elapsed differences from older runs are not a speedup ratio.

An already reproduced separate red warms three genuine C-owned rows yet the
single-row host bind returns result 6 after the first cut when requesting
99 cuts. A C-owned warm cohort must borrow existing row metadata, recheck
physical code/MMU permission at every cut, and preserve context/write/IRQ/
shadow/fault/latch boundaries. Increasing cache quotas or adding a JS branch
executor does not resolve that obligation. No Linux speedup is established.
