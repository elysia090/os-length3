# Long-mode syscall privilege frontier — 2026-10-05

The frozen `be64020` same-bundle run passes the TSS user-fetch #PF gate and
reaches `0x7f2f8acfa0a0`, `0f 05` (SYSCALL), after 194,722,641 retirements /
103,148,627 admissions. The common C compiler returns -102. RAX=158,
RDI=0x1002, RSI=0x7f2f8ad0c438; this is actual guest execution, not a guessed
kernel symbol or a host syscall substitute. `/init` announcement still does
not prove successful PID 1, root mount or shell.
[Exact completed receipt](2026-10-05-node-startup-syscall-red.json), SHA-256
c80df75297bc19a11f21d9ec621fd748698f14b50c6e114106f1cc1e05989d7b.

Loaded VM: 68,451 bytes, SHA-256
3f9abf462f718ce8c4c3edc25b1d66f5b3294a629a84cebcc933bac65a344242.
Loaded compiler: 450,892 bytes, SHA-256
b235e3ec3ac39db29b87acc545ea07b17c0bf3011b24e985c456c74811dd4bb6.
The new candidate below was not loaded in this completed run.

## A bounded architectural transition, not a Linux syscall implementation

For the admitted Intel 48-bit long-mode profile (CET/debug disabled), derive
the transition from existing CPU words and the fixed MSR prefix. STAR, LSTAR
and FMASK have no second owner; absent suffixes denote their reset values.

SYSCALL with SCE=1 saves next RIP in RCX and `(RFLAGS & ~RF)` in R11. Its
new flags are `(saved & ~FMASK) | 2`, RIP is LSTAR, CS is STAR[47:32]&~3,
and SS is the 16-bit STAR[47:32]+8. Native observations retain SS's low two
bits; masking those as TCG does is not the accepted Intel representative.
Forced CS/SS caches have base zero and limit 0xffffffff, attributes a09b/c093.
No GDT/TSS/RSP payload is accessed. In particular noncanonical RSP alone
does not fault; Linux's entry code owns its subsequent stack switch.

SYSRETQ checks SCE, CPL0 and canonical RCX before publishing user state.
SCE=0 produces #UD; CPL/noncanonical RCX produces #GP(0) at the old RIP.
Success gives RIP=RCX, RFLAGS=(R11&0x3c7fd7)|2, CS=(STAR[63:48]+16)|3,
SS=(STAR[63:48]+8)|3, with 16-bit selectors and a0fb/c0f3 forced caches.
RSP, other GPRs and data/FS/GS caches are unchanged. This is deliberately not
IRET's flags mask or lower-privilege data-cache invalidation.

The typed `machine.system_transfer(port,operation,next_rip)->result` C import
accepts only CALL64/RETURN64. No source opcode, syscall number, host handler,
JavaScript/Python interpreter or Linux VFS/process implementation enters it.
It allocates nothing, aborts reservations, validates private port/generation,
the fixed MSR bank and the CPU/cache profile, and publishes the transition
once. Fault/refusal leaves the complete CPU/cache intact. Unsupported
compat/SYSENTER/SYSEXIT/CET/debug projections are explicit refusals.

The common compiler admits a separate one-instruction control cut and the
C wrapper revokes the old execution admission on success. The generated body
adds exactly one retirement; no retirement occurs on fault/refusal. Subsequent
dispatch must obtain a fresh C source/MMU admission in the new CPL/context.
The generated body does not reload/republish C-owned RCX/R11/RIP/flags. That
removes the duplicated physical path: SYSCALL body 357 -> 288 bytes, SYSRETQ
326 -> 285. These are module-byte counts, not an elapsed Linux speedup.

Primary architectural reference: [Intel instruction manual](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf),
SYSCALL/SYSRET operation and exception sections. Hidden cache words remain
complete C-state models; hardware does not expose their entire internal image.

## Independent red and checks

`data/oracle/syscall-entry.S` is a separate Multiboot/GDT/IDT/TSS fixture:
real IRET enters user mode, real SYSCALL reaches a recorded kernel entry,
and real SYSRETQ either returns or faults. Build with `as --32` and
`exception-entry.ld`; run `check-syscall-system.mjs ... whpx`.
Fixture ELF 6,344 bytes, SHA-256
fdcaeede92868e64022bec79b35565a88fc87fc723988e3e0fdbaba82164692b.
QEMU/WHPX is an independent test oracle, never a product dependency.

[64 hardware-assisted rows](2026-10-05-system-transfer-hardware.txt), SHA-256
eb68aace91543dfeef7191c318de7a0ecf90864f25daa52f9001ad0433a9390e:
48 accepted calls, 32 accepted returns, 16 precise return #GP, 16 call #UD.
Includes flags/masks, selector low bits, forced kernel selector outside the
GDT, noncanonical user RSP, noncanonical return RCX and FS/GS preservation.

The old compiler preserves its entire poisoned output/report and returns -102
for both 0f05 and 480f07. [Green comparisons](2026-10-05-system-transfer-green.json)
use actual C, actual generated Wasm, and actual C table dispatch: 640 complete
1,256-byte CPU / 136-byte cache models; 752 direct + 752 dispatch cases;
112 hardware-derived transitions; 1,476 precise fault comparisons; 14
unchanged profile/private-port/stale refusals; two native-C/cold-C byte parity
checks. Dispatch retirement and stale re-entry are checked independently.
Guest RAM remains untouched, including absent GDT/TSS/noncanonical stack.
Five grammar refusals preserve the entire output/report; CLI/control/page-end
checks distinguish accepted SYSCALL from still unsupported SYSENTER.

Native `make check` for VM and compiler/CLI passes with no new warnings.
VM scoped GCC ASan/UBSan: 1,024 whole-state models, 736 faults, 16 unchanged
refusals. Existing IRET (484 dispatch/352 hardware), TSS faults (208 hardware),
IRQ (768 transfers), source cohorts and FXRSTOR (2,304 generated comparisons)
remain green. The compiler's new transfer emitter also passes scoped GCC
ASan/UBSan; its provider libraries are the normal separately built libraries.
Node prefix retains the fixed 86-instruction initial-state witness and complete
relocation/REP state checks. With the immutable image attached its observed
relocation checkpoint is 1,264, not the historical fixed 378 count; the
expanded command parser count is not independently certified. Its quota stop
is not Linux boot acceptance.

TCG is **not** declared equivalent: its strict fixture expectation fails
(48 #GP rather than 16 #GP/32 returns). [Raw TCG rows](2026-10-05-system-transfer-tcg.txt),
SHA-256 a0ccf8761a31b62d717b1e28e25f374d8299c02def8992c5cb816d059b6efc0c.
All 232 field differences are counted/classified in the green receipt, not
discarded: SS low bits (36), entry flags (12), terminal vector (32), frame
RIP (48), CS (16), flags (48), SS (16), active SS (16), active flags (8).
The observed SYSRET transition preserves VM/RF and can publish user state
before a later #GP, unlike this Intel hardware contract. Compare the separate
[QEMU syscall helper](https://raw.githubusercontent.com/qemu/qemu/master/target/i386/tcg/system/seg_helper.c)
and [SYSRET helper](https://raw.githubusercontent.com/qemu/qemu/master/target/i386/tcg/seg_helper.c).
Those moving source pages explain differences; they do not identify the
exact installed executable or replace these versioned observations.

Candidate VM: 69,903 bytes, SHA-256
0d621ee3186d98f181d53a02c8a48ed7ec75f973cfc7f77066a33ed9d7e31f20.
Candidate compiler: 451,602 bytes, SHA-256
5744d1b026f7d5538a088707481e224582d6535371bb6821fc6f36a8e83bce44.
No source metadata/entry ABI/quota growth. Native publication/UI unchanged.

## Maximum measured terms and next run

The completed old run: engine construction 10,222,289 / 384,729.236 ms;
cold C emission 298,479.819 ms; C execution 92,598.248 ms; admission
26,567.329 ms; supply 854.889 ms; total 952,594.974 ms. Engine witnesses:
739 live / 261,843 bytes, 10,221,550 evictions, 28,547,803 hits, unchanged
1,024-entry / 262,144-byte quota. Different retired work/clock calibration
prevents a speedup ratio against previous runs. Linear Memory 22,609,920 bytes
is not process RSS. These are Node diagnostics, not a browser/network measure.

Freeze the candidate and measure the same published bundle, same independent
boot segments/image, warmCuts=64 and unchanged quotas. Follow the next actual
fault/grammar gate; do not infer successful PID1 from this component green.
The frozen independent Node job (old PID 24256, checkpoint f1cd38c) has
completed with these hashes. It passes SYSCALL and reaches unprefixed MOVSB
compiler -102 at 187,420,592 retirements / 97,917,652 admissions. See the
[completed receipt](2026-10-05-node-startup-movs-red.json). Engine construction
still dominates at 335,947 ms, cold emission 265,998 ms, C execution 79,089 ms,
elapsed diagnostic 840,292 ms. Different work/clock calibration is not a
paired speedup ratio; the CALL candidate is not loaded in this receipt.
Real-browser acceptance, root mount, shell, tooling, storage/NIC/HTTPS and
the three-second cold prompt remain open. Retained browser Workers/assets
have not been replaced by these independent Node/native checks.
