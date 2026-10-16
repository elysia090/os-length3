# Return-family closure — 2026-10-08

Same published native bundle and human UI. This is compiled architectural
return support, not a browser Linux acceptance result or product QEMU route.

## One frame transaction

The x86 frontend now normalizes far RET and IRET into width/discard/interrupt
fields. The cold compiler emits ordinary Wasm and one checked machine return
word: low16 parameter release, next2 bits 64(default)/16/32-bit slots. Reserved
words reject. No source opcode, instruction stream or register decoder enters C.
The old 64-bit-only admission blocks are removed.

far RET supports same/outer privilege to long-mode code for all three widths,
including callee and caller parameter release. IRET restores the five-slot frame
at every width, including same-privilege long-mode returns. Target/CS and SS
selector checks precede architectural publication. Only significant selector
bytes are read. Descriptor Accessed writes retain their actual ordering across
later faults/waits. IRET's flag mask follows origin CPL/IOPL and operand width.

GDT/LDT lookup, descriptor Accessed update and outer cache invalidation now have
one implementation shared by fault/IRQ entry, IRET and far RET. Old duplicate
descriptor implementations and forwarding wrappers are removed. Successful
far RET revokes the old execution admission even when descriptors already had
Accessed set; retirement completes once before STALE requests the next binding.
The C transaction alone does not retire; emitted code and the ordinary boundary
owner consume the instruction and its interrupt-shadow lifetime.

Normative architectural references:
[Intel RET](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf),
[Intel IRET](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf).
In long mode, far RET defaults to32-bit slots, with16/64-bit alternatives;
IRET's operand size selects its frame width. Source flags do not gain privilege:
origin CPL governs IOPL/VIF/VIP, old IOPL governs IF, and16-bit frames do not
replace the high flag fields. CET/compatibility-target and general TF/AC
execution remain explicit remaining machine-ABI work, not fake #UD or fallback.

## Independent system records

The existing bare system observer now generates all three return widths and
far RET with0/7 parameter release. Its low identity-map INT landing pad makes
16-bit targets observable without a substitute kernel or OS-side syscall shim.
Real GDT/TSS/IDT and processor frames expose returned RIP/CS/flags/RSP/SS,
data selectors, FS/GS bases, descriptor Accessed bytes and fault/error fields.

Eight fresh WHPX profiles: far RET16/32/64 with0/7 release, IRET16/32,
**2,560 system observations**. Every record matches direct C and cold-compiled
C table execution. The retained IRETQ320 and frame-priority352 observations
also pass: **3,232** combined system rows, plus120 whole-state C models,
12 descriptor/target faults,2 residency retries and stale/refusal checks in
the existing checker. These are hardware-assisted virtual CPUs, not physical
silicon certification or Linux boot.

New C shape models cover all widths, same/outer privilege, origins CPL0..3,
IOPL0..3 and parameter release: **360 complete-state returns/360 untouched
null-selector faults**. C-width models are not substituted for the native
origin-CPL0 observations. Frontend/backend constructors cover**147** forms and
**1,764** malformed descriptors. Full VM/x86/compiler/postlink and positive
ASan/UBSan gates pass without warnings.

TCG is retained as a disagreement oracle, not fitted as the machine contract.
For far RET32/release0, its320 rows differ from WHPX in240 fields:
16 stack-not-present vector differences,144 CS Accessed and80 SS Accessed
differences. C follows the independently observed hardware-assisted effects;
the checker records those differences instead of erasing them.

The older x87 store-fault observer had undeclared XMM replacement around
FXRSTOR and sigsetjmp. Clobbers are now explicit on normal and recovery paths;
diagnostic printing cannot be relied upon to hide compiler-live-register hazards.
Ten repeats without per-row diagnostics pass64 cases each. This changes the reference harness,
not guest semantics or the earlier full-state x87 arithmetic implementation.

## Scope and measurements

Compiler662,863 bytes, SHA256
`e621bbf73bdd51f11106ae6bcb54543b4fd252ecf577ea6627835566eddbd8ba`;
VM98,049 bytes, SHA256
`f76222154bd1faf642e50243644ea60e3e662b36bcc5ab09ac2ce354ab3b0449`.
These are source-scope builds, not an updated signed Linux delivery.

Actual make, same233,455 PF_X-byte domain: **2,099 ->1,389 unresolved**,
**710 recovered** (all466 far returns and244 interrupt returns). Lowerable
232,066; fault/fetch/capacity failures0. No domain pruning or execution-time
fallback. First0f746941 at0xa733 is the remaining MMX/packed-transfer family.
Complete-bundle ZERO remains active work; these numbers do not authorize
publishing an incomplete directory/root.

Same-bundle short Node retains the independent86-step witness,1,617,931 retired
instructions/1,000,000 admissions and quota. The real immutable89,878,528-byte
system image is attached. It is not PID1/shell/toolchain/storage/network/browser
acceptance. The native publication is unchanged; no speed/size/minimum claim.

## Reproduction

```sh
make -C src/v2/vm check
make -C src/v2/wasm-compiler return-check
bash data/oracle/prepare-return-widths.sh NEW-ORACLE-DIRECTORY
node data/oracle/check-iret-system.mjs QEMU.EXE return-4-1-0.elf NEW-WHPX.log whpx --return=4,1,0
node data/oracle/check-outer-iret.mjs VM.WASM COMPILER.WASM WHPX.log --return=4,1,0
# Repeat2/4/8 far0/7, narrow IRET0; retain default IRETQ/frame-priority regressions.
node data/oracle/check-iret-system.mjs QEMU.EXE return-4-1-0.elf NEW-TCG.log tcg --return=4,1,0
node data/oracle/check-outer-iret.mjs VM.WASM COMPILER.WASM WHPX.log TCG.log --return=4,1,0
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Temporary independent logs and module builds are under temp/returns-1008;
they are not bundled into distribution delivery or used as a guest backend.
