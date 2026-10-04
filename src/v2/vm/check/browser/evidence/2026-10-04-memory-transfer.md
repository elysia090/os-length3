# Memory exchange/add — 2026-10-04

The same shipped bundle passes memory XADD in the actual browser. The next
execution refusal is `out 0xa1, al` at `0xffffffff81030a33`: the C I/O provider
owns PIT but not the 8259 PIC. This is result 6 (ENTRY_MAP), not an architectural
#GP. Fault/request fields in the receipt are stale when no fault/wait is pending.
PID 1, shell and the full browser goal remain unachieved.

## Compiled SSA, existing transaction

XADD snapshots the address/source, reserves the destination with read/write
intent, computes the shared ADD value and flags, commits memory once, then
publishes the old memory value to the source parent. XCHG reuses that exact
transaction but stores the source without changing flags. Narrow writes use
the shared parent-register rules, including high bytes and 32-bit zeroing.
Address aliases cannot move the destination between reserve and commit.
LOCK XADD and implicit-atomic memory XCHG use the pinned synchronous single-vCPU
owner; this is not an SMP/SharedArrayBuffer atomicity claim. No opcode callback
or second interpreter was added. Other unsupported LOCK arithmetic remains red.

76 ordinary linked ELF -> independent postlink -> proof-verified optimized ELF
fixtures pass: 38,912 native CPU/RAM and 37,888 protection comparisons through
C vm.wasm, plus 76,800 RF and 76,800 separate dispatcher comparisons, 152
waits/retries and 18,944 readable-but-not-writable faults. The oracle executes
x86 in the QEMU TCG reference build VM, not physical hardware. Native RSP source
observations are not claimed: the observation trampoline owns RSP. The common
decoder matrix does cover all sixteen source GPRs (512 positive entrances).

1,256 cold C-Wasm emissions match native C byte-for-byte across the current
memory transfers, paired exchange, debug/CPU, scans and bundle-prefix fixtures.
`make -C src/v2 -k -j2 check` and selected compiler/lowering ASan+UBSan checks
pass. Prior provider/MMU checks remain green; the VM bytes are unchanged.

```sh
bash data/oracle/prepare-memory-transfer-cuts.sh temp/new-memory-transfers
node data/oracle/check-wasm-provider.mjs VM.wasm temp/new-memory-transfers --dispatch
node data/oracle/check-cold-compiler.mjs COMPILER.wasm temp/new-memory-transfers
```

## Actual browser

[Browser JSON](2026-10-04-memory-transfer-browser.json): 137,134,563 retired /
69,357,027 admissions, no manual branch entries, exact 14,622,864-byte decompressed
ELF proof and Linux entry observed. Six #PF and ten #GP reach guest handlers.
Fourteen clock events; PID 1/shell not reached.

49 fetches / 3,154,432 fetched / 3,046,912 requested bytes, cache high-water
65,536. VM memory 18,874,368; compiler memory 1,048,576; 4,444 resident / 4,431
supplied pages. Source cache 68,015,447 hits / 1,341,580 misses, 64 rows / 6,752
metadata bytes, zero retained payload copies. Engine 1,341,580 compilations /
zero hits, 64 retained modules / 22,203 bytes. 468,183,361 emitted and
5,495,955,456 copied bytes are cumulative work, not resident or delivery size.

Concurrent diagnostic timings: cold 19,083.7 ms; engine 113,497.9; execution
36,386.7; admission 22,901.1; supply 316.4. This is not a controlled speedup or
cold-shell measurement; the three-second objective remains red. Engine reuse
is a known fixed cost, not hidden by this correctness checkpoint.

VM: 41,774 bytes, SHA-256
`15116f16e3eb04bcb1d08444c85e54d79ed94e3413f8a59c1402048de24df957`.
Compiler: 430,665 bytes, SHA-256
`201673dd660f27e1cc3c4b59018a60ed46b59fd071d0936909bbf897be6c158a`.
Native publication/root and human UI unchanged. Diagnostic object digests are
not a signed production admission claim. Next: C-owned PIC port/state model,
then actual browser boot, without silently accepting absent devices.
