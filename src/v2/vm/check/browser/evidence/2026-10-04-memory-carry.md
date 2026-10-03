# Precise memory carry arithmetic — 2026-10-04

The full product goal and shipped native bundle remain unchanged. Linux/PID 1,
offline shell and development tools, authenticated workspace recovery and
granted networking are still required. Cold shell 3 seconds is unmet. No native
rebake or human-UI change is made.

## Red and common lowering

The previous actual browser refused `83 54 24 70 00`, ADC dword [RSP+0x70],0,
at `0xffffffff81203942`. Before implementation, 48 ordinary memory ADC/SBB
entrances were red. Load, register-source RMW and immediate RMW at all four
operand widths and both address widths now enter the same precise memory
path and existing carry-flag SSA, not a coordinate-specific increment.

For width w, incoming c=CF and original a,b, retain

```text
ADC: r=(a+b+c) mod 2^w; CF=(r<a) | (c & (r==a))
SBB: r=(a-b-c) mod 2^w; CF=(a<b) | (c & (a==b))
AF=(a xor b xor r) & 0x10
```

Shared OF/SF/ZF/PF equations consume these originals. Folding b+c modulo w
before flag derivation is not equivalent when b is all ones. Effective address
and original parents precede writes. A C READ supplies the operand; memory
destinations then use the existing RMW reservation/commit. Flags remain local
until every fragment commits. Even immediate zero retains the memory access.
No arithmetic import, interpreter or kernel-coordinate path is introduced.
LOCK ADC/SBB and unsupported FS/GS addressing still explicitly refuse: ordinary
RMW admission is not an assertion of LOCK/SMP semantics or a global minimum.

## Verification and observer corrections

[The native/C-Wasm receipt](2026-10-04-memory-carry-native.json) records 132
ordinary linked -> post-linked -> proof-verified native/cold byte-identical
modules. All widths/address widths, high bytes, extended registers, RIP, SIB,
source/address aliases, sign-extended immediate boundaries and both CF inputs
are observed. 67,584 successful native CPU/RAM comparisons and 59,392 actual
protection-fault frames match direct generated Wasm with the actual C MMU.
126,976 RF checks and separately 126,976 C-dispatch comparisons pass. The
dispatcher compares complete CPU and both operand pages, not private C scratch
bytes. A successful RAM write retires exactly once before returning STALE for
the revoked next admission; it is not replay permission.

The generic observer had two gaps now corrected. Buffer slices were views,
not immutable snapshots; page/directory predictions now use real deep copies.
The write-protection witness had USER=0 and thus faulted on reads too. It now
keeps the original physical owner with USER=1/WRITABLE=0, and independently
proves 18,944 native write-fault operands remain C-readable before the compiled
RMW faults. 264 last-fragment physical waits and 264 identical-input retries
prove no partial payload/CPU/flags and no double carry application. Unary RMW
regressions independently pass the strengthened witness as well.

Full product `make check`, 1,212 cold/native emissions and selected 52-fixture
compiler/lowering/native-observer ASan/UBSan pass without warnings. Decoder,
support and proof archives are normal builds, not whole-TCB sanitizer coverage.
Native observations run in the reference QEMU TCG build VM, not physical
hardware or a QEMU product execution path. Exception entry is not tested by
these user-mode fixtures. Previous 72 memory-divider modules remain green.

Reproduce with `data/oracle/prepare-memory-carry-cuts.sh NEW-DIRECTORY`, then
`check-wasm-provider.mjs VM.WASM NEW-DIRECTORY` and separately
the same command with `--dispatch`. Existing output directories are refused.

Compiler: 425,695 bytes, SHA-256
`fd1d66211929e75bd0b2c278392da22d4df386999c6072962a307fd56997d9de`.
VM: unchanged 36,584 bytes, SHA-256
`105c3be7eb19171c65b39f15922a5f9de6a1bc1849601a5521e701097fb08891`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and next gate

[The fresh actual browser receipt](2026-10-04-memory-carry-browser.json) passes
memory ADC and reaches 136,209,125 retired / 68,765,994 admissions. Next -102
is `0f 01 44 24 0e`, SGDT [RSP+0xe], at `0xffffffff8103af89`.
RSP=0xffffffff81a03ec0, flags=6, CR3=0x1a2a000. The next descriptor-store
checkpoint supersedes the proposed complete write preflight: actual native
observation shows a completed two-byte limit survives a later base #PF.
Use the [ordered-store evidence](2026-10-04-descriptor-transfer.md), not a fixed
Linux descriptor constant or an invented atomic ten-byte store.

Full decompression stays 14,622,864 bytes / 3,571 pages, SHA-256
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Eight #PF and seven #GP events enter Linux's own handlers, with zero manually
listed branch coordinates. Thirteen clock events do not prove Linux calibration.
The diagnostic pass is not Linux boot/PID 1/shell or production authentication.

Delivery stays 49 ranges / 3,154,432 fetched / 3,046,912 requested bytes,
65,536 cache high-water. 4,325 supplies / 4,338 resident pages use 18,350,080
VM memory / 1,048,576 cold memory bytes. Source admission stays 64 rows / 6,752
metadata bytes / zero payload copies, with 67,554,426 hits / 1,211,569 misses.
Engine residence stays 64 modules / 20,139 retained bytes, but 1,211,568
compilations and zero reported engine reuse hits remain a major work cost.
Cumulative 400,611,409 emitted / 4,962,848,768 copied bytes are work, not RSS,
delivery or artifact size. Cold/engine/execution/admission/supply observations
are 24,222.0 / 174,417.8 / 40,547.9 / 24,441.1 / 256.8 ms. This run overlaps
other checks; it is not a controlled speed comparison or cold-ready measurement.
