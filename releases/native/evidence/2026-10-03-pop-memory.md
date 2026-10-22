# Ordered memory POP — 2026-10-03

The full goal remains active: the same published native bundle in the browser,
Linux/PID 1/offline shell and C/make/Git/apk, authenticated bounded workspace
storage/recovery and granted virtual-NIC network/service use. This checkpoint
is not Linux boot, a new distribution or a replacement human UI. Cold shell
3 seconds is unachieved.

## Derivation and single path

The actual preceding refusal was `8f 04 24` at `0xffffffff81033a58`.
The existing decoder already describes an ordinary memory POP, not a machine
escape. Its shared Wasm lowering was missing; no opcode or guest state was
skipped to close it.

The [Intel POP description](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf)
fixes long-mode stack address width at 64 bits, even for address-size 32.
The operand is 16 or 64 bits. A destination using the stack pointer sees its
incremented value. Address-size truncation applies only to the destination.
The observations below separately check fault-time publication and payload;
these details are not inferred from success-only pseudocode.

For operand bytes `b`, address width `a`, old stack `R` and register binding `S`:

```text
v  = read_SS64(R, b)
R' = R + b                  (64-bit arithmetic)
S' = S[RSP := R']           (local SSA binding, not architectural publication)
d  = truncate_a(EA(S'))
write_segment(d, b, v)
publish(RSP := R', RIP := fallthrough, retirement := retirement + 1)
```

Both read and write must complete before the publication. The read returns
before destination translation if it faults/waits. This is two ordered scalar
transactions, not reserve/commit of one RMW address. The emitted module imports
only shared memory and the existing C `machine.access`; the header now retains
that distinction even though the report describes both READ and WRITE.
The value and updated stack stay in locals, with no CPU snapshot or extra
port/opcode interpreter. Common address SSA, precise C-MMU and write observers
remain the owners. A pure predecessor commits as its own cut first.

The accepted ordinary forms include 16/64-bit memory operands, 32/64-bit
addresses, GPR/SIB/displacement/RIP forms and flat DS/SS/CS/ES addressing.
FS/GS memory bases remain explicit grammar refusals; LOCK, unsupported segment
POPs, debug TF and alignment-check AC are not silently admitted. This is not
complete ISA, I/O privilege, exception entry or SMP coverage.

## Red and comparison gates

The new native entrance test first printed
`memory POP form 0 red: compiler=-102`. It separately obtained native CPU/fault
receipts with `--observe` before the common lowering was added.

- 24 native forms / 6,144 complete CPU/RAM observations / 1,952 exception
  frames. The oracle is x86 user-mode execution in the reference build VM
  (QEMU TCG), not physical-hardware evidence. Both-source-and-destination
  failures establish the read priority; cross-page store faults retain CPU
  and payload in these cases. Aliasing, overlapping stack destinations,
  read-only source/destination, absent pages, noncanonical addresses and
  32-bit truncation of a distinct high stack are covered.
- All 24 native/C-Wasm emissions are byte-identical. The actual C-Wasm MMU
  matches all 6,144 cases directly and separately in the C dispatcher;
  complete CPU/hidden-segment/payload preservation is checked. Success retires
  once, then a payload write revokes the bound execution before next dispatch.
  120 entry refusals, 46 physical waits/retries and 6,144 RF comparisons pass.
- Source admission passes 23 actual cold emissions. Equal and changed POP
  writes to code revoke the exact source owner; a disjoint write keeps its
  reusable row. The stack is unchanged; the instruction retires once.
- Full `make -C src/v2 -j2 check` passes without warnings. Selected compiler
  lowering plus the new observer pass ASan/UBSan. Linked decoder/support/proof
  archives are normal builds: this is not a whole-TCB sanitizer claim.
  The observer's original high mmap collided with ASan's reserved layout;
  relocating that test-only stack to a disjoint canonical high mapping made
  the same normal and sanitized cases pass. Product addresses are unchanged.
- 801 native/cold emission regressions pass. Fresh CALL receipts add 27
  byte-identical modules, 6,912 CPU/stack observations, 2,150 fault frames,
  448 retained target-#GP stores and 6,912 RF checks. The old CALL script's
  unconditional RF rejection was stale, not a product regression; it now
  checks RF preservation on faults and clearing only on successful retirement.
  LEAVE's 1,536 / 490 fault cases and PUSHF/POPF's 8,192 privilege-model cases
  / 4,096 real CPL3 comparisons pass as separate regressions.

Compiler: 421,229 bytes, SHA-256
`a703ab27c5f8e397b5b5c82d54f1697522563330115ae0bdf03680084eec0358`.
VM: unchanged 32,033 bytes, SHA-256
`d72f78f71d72faf6de93b16dd63f6dfb560f367ab49030903f0ee08e0e1c4812`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and next gate

The actual bounded receipt reaches
130,560,767 retired / 65,228,273 admissions. POP retires at the original
coordinate and continues to `0xffffffff81033a5b`. Complete independent
decompression stays 14,622,864 bytes / 3,571 pages, digest
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Eight #PF and six #GP events still enter Linux's own handlers.

The next refusal is `e4 61` (IN AL,0x61), status -102, at
`0xffffffff810338c5`, followed by AND/OR and `e6 61` (OUT 0x61,AL).
The same fixed kernel source's `arch/x86/kernel/tsc.c:quick_pit_calibrate`
uses that I/O sequence, then channel-2 mode/count ports 43/42 and TSC reads.
This identifies the device/time contract to implement, not an optimized
System.map symbol proof. A constant port value, guessed TSC, changed CPUID,
guest patch, host-selected calibration result or kernel-specific handler is
not an acceptable fix. Next close general IN/OUT through the C device ABI and
give PIT/TSC a consistent, explicit clock/event owner with independent tests.

Delivery/residency remains 49 ranges / 3,154,432 fetched / 3,046,912 requested
bytes, 65,536 cache high-water, 3,697 supplies / 3,710 resident pages. Source
metadata is 6,752 bytes / 64 rows / zero payload copies. VM/cold memory stays
15,728,640 / 1,048,576 bytes. Engines retain 64 modules / 20,942 bytes.
201,264,514 emitted / 2,419,482,624 copied source bytes are cumulative work,
not unique delivery, RSS or artifact size. Engine/execution/admission/cold
buckets are 54,812.1 / 47,806.0 / 29,271.3 / 9,267.9 ms: uncontrolled observations,
not a new native benchmark, speedup or cold-ready claim.
Signed-root/AEAD/ECC production admission, PID 1/offline tools, workspace
recovery and granted networking remain unverified; diagnostic `pass` does not
complete the goal.
