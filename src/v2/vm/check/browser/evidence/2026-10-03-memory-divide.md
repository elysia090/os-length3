# Precise memory division — 2026-10-03

The shipped native bundle, fixed CPU profile and full browser product goal
remain unchanged. Linux/PID 1/offline shell, the included development tools,
authenticated workspace recovery and granted networking are still required.
Cold shell 3 seconds is unmet. No native rebake or human-UI change is made.

## Red and common lowering

The previous actual browser refused `f7 7c 24 04`, IDIV dword [RSP+4],
at `0xffffffff81008e75`. A native-only observer captured all 72 ordinary
memory DIV/IDIV forms before requiring lowering. The old compiler reproduced
`memory divide form 0 red: compiler=-102`; a readable divisor and a protected
operand page have independent actual x86 observations.

The [Intel DIV/IDIV reference](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf)
defines the implicit dividend/result registers, quotient limits, divide errors
and undefined arithmetic flags. This change does not introduce a second
divider: the existing register divider consumes the captured raw operand.

```text
effective address -> C-MMU complete READ -> captured divisor
                                          |
                         existing quotient/remainder/#DE SSA
                                          |
                       implicit registers -> successful retirement
```

An operand #PF or physical-residency wait returns before zero/overflow
guards. A readable zero divisor or unrepresentable quotient returns #DE,
with original registers/flags/RIP/retirement. Up to dword operands the full
dividend fits i64; qword division retains the existing exact 128/64 divider.
Successful byte division writes AX; word division preserves upper parents;
dword division zero-extends EAX/EDX; qword division writes RAX/RDX. Divisor
and effective address precede every aliased implicit write. Undefined flags
keep the incoming representative; only successful retirement clears RF.
This exact lowering is not a global minimum work/span claim.

Memory-first operand does not mean a STORE/RMW. Only the existing
`machine.memory` and `machine.access` imports remain. No runtime division
callback, engine trap used as #DE, opcode interpreter or kernel-coordinate
arithmetic is introduced. A preceding pure instruction retires in a separate
cut before memory division can fault. Invalid LOCK and unsupported FS/GS
addressing remain explicit compile refusals; short output does not publish
source, module, report or size changes.

## Verification

[The native/C-Wasm receipt](2026-10-03-memory-divide-native.json) records:

- 72 native/cold byte-identical modules over both signs and 8/16/32/64 widths,
  with 32/64 addressing, RAX/RDX base aliases, RSP+4, extended GPR, RIP, SIB
  and split operands whose physical pages are non-adjacent in the C arena.
- 36,864 actual x86 observations: 17,266 successes and 19,598 #DE frames.
  Protecting the last operand page produces 36,864 native #PF frames,
  including every previously zero/overflow input. CR2 and unchanged full
  CPU/payload state are checked, not merely quotient values.
- Separately, 221,280 actual C-dispatch comparisons, 147,456 RF checks,
  73,728 residency waits and 73,728 exact-input retries. The full CPU,
  payload, page tables and scratch port are byte-compared. C dispatch's
  execute-permission fetch retains its first-byte scratch value on failed
  operand reads; physical page requests strip the guest stack attribute.
- 576 entry refusals and 192 #GP/#SS address-model checks. The latter are
  explicitly not native fault observations or exception-delivery evidence.
  TF/AC, port alias/alignment/bounds, wrong RIP, stale and closed generations
  cannot change the caller arena.
- Prior register division remains byte-identical over 32 modules / 16,384
  observations / 10,348 #DE frames and 1,140 algebraic wide-boundary cases.
  Full product `make check`, 1,080 cold/native emissions and selected
  compiler/lowering/native observer ASan/UBSan pass without warnings.
  Linked decoder/support/proof archives are normal builds, not whole-TCB
  sanitizer coverage. Native x86 is observed in the reference QEMU TCG build
  VM, not physical hardware or a QEMU product execution path.

Reproduce with `data/oracle/prepare-memory-divide-cuts.sh NEW-DIRECTORY`,
then `check-memory-divide.mjs VM.WASM COMPILER.WASM NEW-DIRECTORY`.
`memory-divide-check NEW-DIRECTORY --observe` records native rows without
requiring lowering; existing outputs are refused. Bare source pages model
boot code, not an invented optimized-ELF proof.

Compiler: 425,534 bytes, SHA-256
`3bcce33dfd66a1b520114b4aeafed8923c8a23a39d0275285d554d1150e79dc1`.
VM: unchanged 36,584 bytes, SHA-256
`105c3be7eb19171c65b39f15922a5f9de6a1bc1849601a5521e701097fb08891`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and next gate

[The real browser receipt](2026-10-03-memory-divide-browser.json) passes
the previous memory IDIV and reaches 136,129,036 retired / 68,707,852 admissions.
The next -102 is `83 54 24 70 00`, ADC dword [RSP+0x70],0, at
`0xffffffff81203942`. RSP=0xffffffff81a03d18, flags=0x46, CR3=0x1a2a000.
Next connect memory ADC/SBB through the existing carry SSA and precise
C reserve/commit, rather than a coordinate-specific increment.

Complete decompression remains 14,622,864 bytes / 3,571 pages, SHA-256
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Eight #PF / seven #GP events enter Linux's own handlers; zero manual branch
entries. Ten clock events do not prove selected Linux calibration frequency.
The diagnostic `pass` is not Linux/PID 1/shell or production admission.

Delivery: 49 HTTP ranges / 3,154,432 fetched / 3,046,912 requested bytes,
65,536 cache high-water. There are 4,275 supplies / 4,288 resident pages,
18,350,080 bytes VM memory / 1,048,576 cold memory. Source identity remains
64 rows / 6,752 metadata bytes / zero source payload copies, with 67,518,213
hits and 1,189,640 misses. Engine residency stays at 64 modules / 20,636 bytes,
but 1,189,639 compilations and zero reported reuse hits remain a major cost.
Cumulative emitted 393,118,734 / copied 4,873,027,584 bytes are work, not
RSS or artifact/delivery size. Cold/engine/execution/admission/supply timings
are 16,748.7 / 97,052.7 / 35,250.5 / 22,537.7 / 165.3 ms; uncontrolled
progress observations, not a benchmark speedup or cold-ready measurement.
