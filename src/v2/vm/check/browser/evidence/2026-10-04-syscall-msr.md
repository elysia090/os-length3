# Syscall MSR ownership — 2026-10-04

The product goal and native bundle are unchanged: the independent C cold
compiler and C VM must run real Linux/PID 1/offline shell, C build/run,
make -j4, local Git/apk, authenticated minimal-page workspace recovery and
granted NIC HTTPS/Git/service access. Cold shell 3 seconds remains unmet.
Native release and human UI bytes are not changed. No interpreter,
kernel-coordinate constant, instruction skip or execution fallback is added.

## Red and common owner

The prior actual browser stopped at WRMSR IA32_STAR, `0xffffffff8103adf2`,
ECX `0xc0000081`, EDX:EAX `0x0023001000000000`. The common compiler already
emitted WRMSR; C returned ENTRY_MAP because the advertised syscall MSRs were
not implemented. New general C tests were first red: 957 failed assertions.
The owner now admits STAR/LSTAR/CSTAR/FMASK through the same `machine.msr`
boundary as EFER, FS/GS bases, MISC_ENABLE and SWAPGS.

The fixed Intel profile distinguishes four value laws. STAR's low 32 bits
and FMASK's high 32 bits are reserved. LSTAR writes require a 48-bit
canonical address. Intel's unused CSTAR remains a full-width read/write
value; it is not dereferenced or given an invented canonical-address fault.
SCE does not gate MSR access. CPL denial and bad values precede publication.
These contracts derive from the
[WRMSR instruction reference](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2c-manual.pdf),
[system-call register layout](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-3a-part-1-manual.pdf)
and [architectural MSR table](https://cdrdv2-public.intel.com/835765/335592-sdm-vol-4.pdf).
Reserved/canonical fault checks are model evidence, not observed physical CPU
faults. The declared initial syscall-register values are zero; that is an
explicit VM profile initial state, not arbitrary unknown-MSR reset-zero behavior.

The residual bank is one bounded prefix of six fixed ranks: inactive GS,
MISC_ENABLE, STAR, LSTAR, CSTAR, FMASK. Reads of absent ranks use their
declared initial values without creating state. Writes initialize only the
missing prefix and never drop later live ranks. Uncounted keys/values are
irrelevant even when poisoned. EFER and active FS/GS retain their existing
owners. There is no alternate dictionary or syscall shim.

Generated CPUID now enforces the same six-rank resume invariant and reads
MISC_ENABLE whenever rank 1 is live, not only when count equals two.
Its validation is compiled at fixed ranks, with no host import or runtime
dictionary scan. Unknown/duplicate/reordered keys, reserved values and
noncanonical LSTAR/inactive GS refuse admission without changing CPU state.
The advertised TSC MSR remains explicitly unimplemented; it is not made #GP
or given a fabricated constant. Syscall execution itself is not closed here.

## Verification and reference differences

- Native C: 2,388 privilege/value cases, plus reset/read/no-materialization,
  poisoned uncounted payloads, high-rank preservation, SWAPGS, stale generation
  and corrupt persisted bank assertions. Complete state/cache comparisons.
- Generated WRMSR/RDMSR/SWAPGS with the actual C provider: 3,513 models and
  five C-MMU/dispatcher cases. High halves of RAX/RDX/RCX are ignored as
  required; failures publish no GPR/RIP/retirement. RF retirement and old
  EFER/base/MISC behavior are retained.
- Generated CPUID: 60,032 complete CPU direct/C-dispatch comparisons and
  60,046 TF/bank refusals. Counts 3..6 with live MISC controls and a
  noncanonical unused CSTAR are covered, as are all four new key corruptions,
  STAR reserved bits, noncanonical LSTAR and FMASK reserved bits.
- [The system-observer receipt](2026-10-04-syscall-msr-native.json): 288 unique
  CPL0 source rows, each joined to a known key/value and complete four-MSR
  readback. The actual C-Wasm test makes 1,440 write/read comparisons.
  194 native rows match; none proves a #GP. The 94 explicit reference
  differences are 36 reserved STAR values, 20 noncanonical LSTAR values and
  38 reserved FMASK values that QEMU accepts. Every differing row still
  validates unchanged flags, exact readback, vector/error and the complete
  C refusal state. They are not silently discarded or called matches.

The [QEMU MSR helper](https://gitlab.com/qemu-project/qemu/-/raw/master/target/i386/tcg/system/misc_helper.c)
is a reference implementation, not the architectural fault specification or
product runtime. The first system-observer attempt ended after only 78 rows,
with no valid complete-grid receipt. It had no masked PIC or #GP continuation.
The corrected observer masks legacy PIC inputs and installs an explicit #GP
capture, then produces all 288 rows and isa-debug-exit status 33. This repair
is confined to the oracle; no guest instruction is skipped by product code.
The initial exit's exact cause is not inferred from the partial trace alone.
The full 59,040-byte trace has SHA-256
`eccb2a29b36a55ad11e4aab0bc90e8cb78737aa608f748927ff43b805c4893e5`.

Full `make -C src/v2 -k -j2 check`, all linked VM-core ASan/UBSan and the
complete lowering library's selected code-cut sanitizer harness pass without
warnings. Decoder/support/proof archives in that compiler run are ordinary
builds; this is not whole-TCB sanitizer coverage. Current 622 native/cold
emissions are byte-identical. Old MSR system reference (32 rows/160 comparisons),
LLDT/LTR (144 forms/153,360 models/144 waits/3,024 native matches), memory
division (72 forms/36,864 comparisons/73,728 waits/retries) and IO/clock
(26 forms/3,328 comparisons) regressions pass. The preceding checkpoint's
intermittent CALL reference failure is not claimed resolved; this full run
passed without a retry.

Reproduce in an ordinary x86 Linux test oracle:

```sh
mkdir NEW-CUT-DIRECTORY
make -C src/v2/wasm-compiler build/code-cut-check
src/v2/wasm-compiler/build/code-cut-check NEW-CUT-DIRECTORY
bash data/oracle/prepare-msr.sh NEW-ORACLE-DIRECTORY syscall
qemu-system-x86_64 -machine pc,accel=tcg \
  -cpu qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-xsave,-avx,-aes,-pclmulqdq,-monitor \
  -m 32M -nodefaults -no-reboot -display none \
  -kernel NEW-ORACLE-DIRECTORY/entry.elf \
  -debugcon file:NEW-ORACLE-DIRECTORY/trace.log \
  -global isa-debugcon.iobase=0xe9 \
  -device isa-debug-exit,iobase=0xf4,iosize=4
node data/oracle/check-msr-syscall-system.mjs VM.WASM NEW-CUT-DIRECTORY \
  NEW-ORACLE-DIRECTORY/trace.log
node data/oracle/check-msr.mjs VM.WASM NEW-CUT-DIRECTORY
node data/oracle/check-cpuid.mjs VM.WASM NEW-CUT-DIRECTORY
```

The oracle directory must be new. Successful isa-debug-exit is status 33,
not ordinary exit 0; full-grid admission remains mandatory.

VM: 39,498 bytes, SHA-256
`251997663d3a860952b7c22668f582e976d94bb8f711a2cddafc13a5db42aef3`.
Compiler: 427,346 bytes, SHA-256
`4fd0bdec338a3f23b43f21a9b4db2e45c301eb323070d1667c9dee39977bc64a`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and next gate

[The fresh actual browser receipt](2026-10-04-syscall-msr-browser.json)
passes the old STAR gate and reaches 136,211,240 retired / 68,767,197
admissions with zero manually listed branch coordinates. It now refuses
`0f 23 f8` at `0xffffffff8103b125`, MOV DR7,RAX, RAX `0x400`. This is compiler
GRAMMAR (-102), not a C MSR refusal or a guessed exception. Source bytes
`0f23f8b8f00fffff0f23f031c00f23` are independently verified against the
decompressed optimized ELF PT_LOAD, whose SHA-256 remains
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
The C decoder already types the debug-register family; the common lowering
and precise debug-register owner are the next missing boundary. Cover read,
write, privilege, reserved/alias behavior and debug faults with common
system-oracle red cases; do not publish fixed Linux DR values or ignore GD.

The same full 14,622,864-byte / 3,571-page decompressed output is checked.
Six #PF and ten #GP events enter Linux's own handlers. Thirteen clock
events are not boot readiness. Linux/PID 1/shell, C compile/run/make/Git/apk,
production authenticated storage/lifecycle/NIC and cold shell 3 seconds are
still unachieved. Diagnostic status pass is not product success.

Delivery remains 49 ranges / 3,154,432 fetched / 3,046,912 requested bytes /
65,536 cache high-water. There are 4,325 supplied / 4,338 resident pages,
18,350,080 VM-memory bytes and 1,048,576 cold-memory bytes. Source admission
retains 64 rows / 6,752 metadata bytes / zero payload copies, with 67,554,913
hits and 1,212,285 misses. Engine residence is 64 modules / 20,390 bytes,
but 1,212,284 compilations and zero reported reuse remain dominant work.
Cumulative 400,848,840 emitted / 4,965,781,504 copied bytes are work, not
resident memory, delivery bytes or native bundle size.

Cold/engine/execution/admission/supply observations are 17,387.0 / 100,823.5 /
35,553.2 / 22,206.4 / 261.7 ms. Other checks overlapped; clock calibration
branches can vary. These are not a controlled speed comparison, boot
percentage or cold-shell latency. Fixture hashes are local diagnostic
integrity, not production authenticated root/AEAD/ECC admission.
