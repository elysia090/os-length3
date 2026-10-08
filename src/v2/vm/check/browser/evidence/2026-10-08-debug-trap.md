# Explicit debug trap through the common event frontier — 2026-10-08

Baseline `490f103` refuses F1/-102. The current path recovers **228** actual
published-make coordinates: 4,609 -> **4,381 missing**, 229,074 lowerable of
233,455. Unlowered fault coordinates are now zero in THIS image inventory,
not a complete ISA or machine proof. First is DE BF 03000000 / FIDIVR m16 at
0xa268. Whole-directory publication still refuses -102 BEFORE mkdir/root.
Native publication and human UI are unchanged; no signed Linux root or boot.

## Required distinctions and shared ownership

F1/INT1 and CC/INT3 now consume one checked x86 trap descriptor and the same
ordinary Wasm -> C exception import. Ordinary CD 01/CD 03 remain different,
unimplemented software-interrupt forms, not aliases. The law checks operation,
flow/family, exact vector/opcode, trap flags, decisive extent and absence of
operands/memory effects. No opcode or host handler pointer enters the VM.

Intel's [INT1 trap/debug description](https://cdrdv2-public.intel.com/858456/253669-088-sdm-vol-3b.pdf)
and [IDT DPL exception for F1](https://cdrdv2-public.intel.com/812386/253668-sdm-vol-3a.pdf)
require treating explicit #DB differently from #BP. Both save the next
coordinate/RF=0 on successful trap delivery, but #DB bypasses gate DPL and
sets EXT on IDT/GDT delivery errors. The C owner therefore separates IRQ
origin, software-DPL checks, trap frame selection and error EXT. They cannot
be represented by one overloaded `external` boolean.

The unchanged **168-byte** event frontier adds a kind, not another frame
generator. Explicit #DB clears DR6.B0..3 and DR7.GD once at admission. These
effects persist through host waits and secondary architectural failure.
In-flight debug trap is recognized by the existing continuation/boundary
owner, so a frame wait resumes rather than being rejected as a foreign event.
The general fault entry can also deliver pending #DB from the existing GD
transfer owner; general single-step/address breakpoint execution is NOT added.

Hardware confirms a subtle transaction boundary: a bad F1 IDT/GDT saves F1's
ORIGINAL coordinate, RF=1, without successful F1 retirement, but debug status
is already changed. Do not advance the instruction early or roll back all CPU
words on delivery failure. Successful delivery publishes handler state, then
the existing generated epilogue retires exactly once. Ordered frame stores and
consumed descriptors remain pinned across residency waits. No new import ABI,
runtime interpreter, single-opcode VM evaluator or program-specific escape.

## Independent observations and the rejected conflation

The existing `debug-entry.S` long-mode/IDT/Multiboot scaffolding includes the
new `debug-trap-cases.inc`; it is a standalone reference ELF, not another
machine implementation or a product kernel. GNU `as --32`/ELF32 relocations
use 32-bit coordinates, while actual tested code executes in 64-bit mode.

Eight prefix forms x two gate types x GD/DR6/RF contexts x no/MOV SS/STI
predecessor produce **768** normal rows. A second population has **768** rows:
192 normal and 576 bad-present/type/selector deliveries. No first trap is
overwritten by an observer-triggered reentry; a separate counter records it.

With explicit WHPX (`qemu64,-svm`, no network, one CPU), all normal rows save
the coordinate immediately after F1, clear RF, clear GD and clear DR6 low
status bits. The failure population gives:

| Invalid delivery | Rows | Exception/error | Saved coordinate | Saved RF |
| --- | ---: | --- | --- | --- |
| Gate not present | 192 | #NP / 11 | original F1 | 1 |
| Invalid gate type | 192 | #GP / 11 | original F1 | 1 |
| Selector beyond GDT | 192 | #GP / 25 | original F1 | 1 |

All retain the same debug changes. **Both populations match current C compiler/
MMU/frame execution**. Full CPU/RAM models are checked, but other GPR invariance
is architectural rather than all host GPRs being captured. WHPX is an explicit
host-assisted reference, NOT a bare-metal or universal-CPU certificate.

The SAME reference ELF under TCG gives **384 observer reentries and 480 DR6
differences**, despite identical first-frame observations. Initially its nested
#DB overwrote the original frame: reading DR6 with GD still active triggered
another exception. The observer now preserves the first frame and marks
reentry. These records are retained, NOT fitted to product semantics or silently
masked into agreement. No claim about the exact underlying emulator defect is
needed to reject them as the primary debug-status oracle.

A separate physical-Windows CPL3 observer executes F1 at the end of an RX
page, with its successor page inaccessible. **512 saved RIP/RFLAGS observations
/ eight prefix forms / zero mismatches** confirm that #DB precedes successor
fetch and saves the next coordinate. It neither reads raw privileged DR state
nor certifies gate/frame semantics. It uses a local vectored handler, restores
execution via a RET stub and removes the handler/pages; no global settings.

## Common gates and actual scope

16 native/cold trap forms have identical ordinary Wasm bytes; 192 malformed
laws refuse shared/native owners. Source-prefix splitting and immutable refusal
outputs pass. Old negative controls used F1 as an unsupported instruction;
they now use ordinary CD 01, keeping the grammar-refusal gate instead of
weakening it. LOCK F1 remains a decoder-proved #UD, not trap success.

The SAME old #BP driver now covers #DB too: **2,048 complete CPU/frame models,
128 waits/resumes, 192 delivery faults and 112 entry refusals**. Debug effects
are expected on waits/failures rather than incorrectly comparing to an unchanged
CPU. A consumed gate is corrupted after partial frame stores; resume cannot
reread/replay it. Native C frame tests also retain their physical-alias retry.
Positive frame-owner and emitter ASan/UBSan, full x86/VM/compiler/postlink checks
are warning-free. Previous 42,624 exact register-arithmetic rows remain green.

The accepted profile still refuses active address breakpoints/TF execution,
IST stacks, unsupported mode/privilege descriptors and double/triple-fault
escalation. The system observations here are CPL0/IST0; existing TSS.RSP0
outer-origin behavior is modeled separately, not newly certified by this matrix.
Disabled-breakpoint address-match nuances and broader CPU variants are not
certified by these zero-address reference inputs. Do not call Linux debug,
ptrace, signal or general machine semantics complete.

Compiler **602,806 bytes**, SHA-256
`6df97ac06bad65070e5e1a1be35635578af7d93a1c798a69e147f0fe5f49be98` (+200).
VM **96,861 bytes**, SHA-256
`51cca38ac180be8dfdc61106c0f899e652d5dfa0015c1e5da06b96545418798c` (+165).
No size/speed/minimum/RSS claim. Same-published-bundle short Node retains its
86-instruction independent witness, 1,617,931 retirements / 1,000,000 admissions,
then quota. **No fresh browser Linux run, PID 1/offline shell or signed root.**

## Reproduction

```sh
bash data/oracle/prepare-debug.sh NEW-REFERENCE-DIRECTORY --traps
bash data/oracle/prepare-debug.sh OTHER-REFERENCE-DIRECTORY --trap-faults
# Explicit reference-only QEMU accelerator; no product runtime/backend.
qemu-system-x86_64 -machine pc -accel whpx -cpu qemu64,-svm -m 64 -smp 1 \
  -display none -monitor none -nic none -serial none -no-reboot \
  -kernel NEW-REFERENCE-DIRECTORY/entry.elf -debugcon file:NEW-TRACE \
  -global isa-debugcon.iobase=0xe9 -device isa-debug-exit,iobase=0xf4,iosize=0x04
# Expected terminal exit 33 and 768 complete 25-word rows.
node data/oracle/check-debug-trap.mjs VM.WASM COMPILER.WASM NEW-TRACE
node data/oracle/check-debug-trap.mjs VM.WASM COMPILER.WASM FAULT-TRACE --faults
wasm-compiler/build/software-interrupt-check NEW-NATIVE-CUT-DIRECTORY
node data/oracle/check-software-interrupt.mjs VM.WASM COMPILER.WASM NEW-NATIVE-CUT-DIRECTORY
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Physical-Windows observer: compile `wasm-compiler/check/debug-trap-observe.c`
with GCC C11/Wall/Wextra/Wpedantic/Wshadow/Wconversion, or its optional Makefile
target. It is not a default Linux acceptance test.

Receipts under `temp/debug-trap-1008`: `whpx-primary.txt` SHA-256
`7c2a3ae1bb4f3a38cdecba3ea603a3d65e98175ead20331f919780665502b88c`,
`whpx-faults.txt` `00f242ce02b1c9133eccd3bd99ba0cdb6e9ef285c2e9621c6eca634a5c3cf9d6`.
Observer executable `3b96eb839a252784912a4560a6c51720b8e4b711abcd3bd5fbe7ef9ee811466f`.
TCG diagnostic: `tcg-primary.txt`, explicitly not the product expected status.
The old compiler is still mechanically red with this strict checker; no expected
hardware record is patched. Native bundle/UI stay unchanged. Next FIDIVR needs
shared exact numeric/exception lowering, followed by complete machine/closure/
residency/recovery and the original real-browser development-OS acceptance.
