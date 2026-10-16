# CPU controls, implicit sign extension and precise division — 2026-10-03

Goal stays active: the same published native bundle -> independent cold C
compiler -> C vm.wasm -> actual browser Linux/PID 1/offline shell, included
C/make/Git/apk, authenticated workspace/storage recovery and granted NIC use.
Component pass is not boot success; cold shell three seconds remains unmet.
Native publication and human UI are unchanged.

## Common architectural fixes and red witnesses

The former pending `RDMSR ECX=0x1a0` now uses the declared Intel MISC_ENABLE
contract, not a changed CPU signature, guest patch or default-zero dictionary.
Fast strings reset enabled, Limit CPUID and XD-disable reset clear; unavailable
BTS/PEBS status bits remain set. Fixed residual ranks hold only inactive
KERNEL_GS_BASE and MISC_ENABLE. EFER and active FS/GS retain their original
owners; reset rows do not need materialization. Bank validation ignores dead
uncounted words but rejects unknown, duplicate, reordered or inconsistent
live rows. SWAPGS and inactive-base writes preserve the control row.

Effective CPUID has the same bounded bank validation compiled directly into
Wasm: Limit CPUID lowers the basic maximum to two, XD-disable hides NX.
EFER.NXE cannot be enabled while NX is hidden. Reserved/privilege checks remain
precise. Status-changing writes and XD-disable while NXE is already active
still refuse admission explicitly; their hardware write semantics are not
invented. TSC/SYSCALL-family MSRs remain pending. EFER/MISC writes revoke current
execution admission. Compiler Wasm dependencies now include the shared CPU/ABI
headers, so a profile change cannot silently retain an old compiled module.

1,245 native C and 2,281 C-Wasm MSR model cases pass, including five table
dispatch cases. CPUID passes 60,032 complete CPU cases in direct Wasm and
separately C dispatch; 60,039 TF/bank refusals preserve CPU. These are literal
contract/SDM checks, not physical privileged-hardware comparisons. An actual
QEMU TCG system trace has nine legal MISC rows / 17 comparisons, but TCG leaves
CPUID unchanged after Limit/XD writes. Thus this oracle proves legal value
transport/reset/flags only, **not those control side effects**. Its absent
BTS/PEBS status is projected explicitly rather than hidden in a comparison.

Real-browser progression first reaches `CDQ` at `0x13fa213`, then `IDIV r12d`
at `0x13fa22c`. Native-only observation captures the former six sign-extension
operations while lowering still returns -102. All CBW/CWDE/CDQE/CWD/CDQ/CQO now
use current slice SSA values, including implicit parents and composed MOV
consumers. Wasm sign-extension plus a sign mask replaces instruction callbacks.
Narrow parents, 32-bit zeroing, flags and ignored prefixes pass 18 forms / 4,608
actual x86 observations, in both direct Wasm and C dispatch, plus 72 refusals
and successful RF clearing. No VM opcode decoder was added.

Register DIV/IDIV at 8/16/32 bits snapshot aliased divisor/dividend before any
write. Zero, the i64 signed-overflow case and destination-range overflow return
the existing #DE port before CPU/RIP/retirement publication; no Wasm trap escapes.
An earlier pure write occupies its own completed cut. Quotient/remainder and
7,661 actual #DE frames match 24 forms / 12,288 actual x86 observations in direct
Wasm and separately C dispatch. 120 no-publication refusals and RF success/fault
checks pass. Undefined arithmetic flags keep their declared incoming
representative; only defined native flags are an oracle. 64-bit division and
memory divisors remain explicitly unsupported, not narrowed or interpreted.
The native user-mode oracle runs inside the reference build VM, not physical
hardware. #DE comparison is not exception-entry completeness.

The next real red is memory BTS at `0xffffffff8102dc25`. Immediate memory
BT/BTS/BTR/BTC at 16/32/64 bits now compile through the existing READ or
reserve/commit C-MMU boundary. Only CF changes; no GPR is written. All RMW flags
stay local until commit succeeds. 18 ordinary post-linked ELF forms / 9,216
complete CPU/RAM comparisons and 8,704 actual protection-fault comparisons pass
with C vm.wasm/MMU. This component oracle invokes the generated cut directly;
it is **not a separate table-dispatch or exception-entry claim**. RIP-relative,
SS, SIB, 32-bit addresses and split pages are covered. LOCK and register-indexed
memory bit strings still refuse; a signed word displacement cannot be replaced
by a masked immediate index. Old rejection-only checks are replaced by accepted
precise-cut checks plus these still-genuine negative cases.

316 native/cold C-Wasm emissions are byte-identical. Full product checks and
selected compiler/lowering ASan/UBSan pass. Decoder/provider archives linked
into that sanitizer executable are normal builds, not whole-TCB coverage.
Previous LEAVE, MSR and CPU regressions remain green.

## Architectural sources and independent reference scope

* [Intel SDM Volume 2A](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf):
  CBW/CWDE/CDQE, CWD/CDQ/CQO, DIV/IDIV and memory bit operations.
* [Intel model-specific tables](https://cdrdv2-public.intel.com/843823/252046-sdm-change-document-1.pdf):
  MISC_ENABLE fast strings, Limit CPUID, unavailable BTS/PEBS and XD-disable.
* [Intel Volume 3A](https://cdrdv2-public.intel.com/874249/253668-090-sdm-vol-3a.pdf):
  unavailable NX implies EFER.NXE write #GP.
* [QEMU TCG MSR implementation](https://raw.githubusercontent.com/qemu/qemu/master/target/i386/tcg/system/misc_helper.c):
  inspected to distinguish its stored MISC value from effective CPUID behavior.

## Reproduction

Native tools: `extend-check DIRECTORY`, `divide-check DIRECTORY`,
`prepare-memory-bit-cuts.sh NEW-DIRECTORY`, `prepare-msr.sh NEW-DIRECTORY misc`.
Keep a default 32-row MSR oracle as well as the nine-row MISC oracle.
Use `check-extend.mjs`, `check-divide.mjs`, `check-msr.mjs`, `check-cpuid.mjs`,
`check-msr-misc-system.mjs` and `check-wasm-provider.mjs` with freshly emitted
fixtures. Run full `make -C src/v2 -j2 check` and selected sanitizers. Regenerate
the diagnostic startup files with the unchanged shipped prefix and fresh
VM/compiler, then open `startup.html?budget=extended` in an actual browser.
Raw receipts live under Windows `temp/`; bounded committed receipt below is
a projection of visible `#result`, not a boot snapshot or guest memory input.

## Final actual-browser checkpoint

The [bounded visible receipt](2026-10-03-misc-arithmetic-browser.json) comes
from an ordinary-memory, secure-context Worker at
`startup.html?budget=extended`, after regenerating its VM/compiler inputs.
`status=pass` means the bounded diagnostic observations pass;
`linuxBoot=not-achieved` is the product result. This is not a terminal or
replacement human UI. The unchanged 63,219,311-byte native archive hashes to
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

The guest executes 129,063,662 source instructions / 64,421,578 admissions,
with 64 live table slots and zero manually supplied branch coordinates. All
14,622,864 decompressed bytes / 3,571 pages still match independent gzip output
before the guest's PT_LOAD moves. Linux executes the shipped physical ELF
entry and adopts its own high virtual mappings. Five decompressor #PFs and
the following high-virtual #PF at `0xffffffff814017e2`, read error 0 / address
`0xffff888000001000`, enter the guest handler and return. No host PTE repair
was inserted. These six observed faults are not complete exception/MMU proof.

The next compiler refusal is -102 at `0xffffffff81401759`:
`ff 05 a1 c8 75 00`, `INC dword ptr [RIP+0x75c8a1]`, effective address
`0xffffffff81b5e000`. It follows the real #PF/IRET path and has not retired.
Next close the common memory INC/DEC/NEG/NOT family with native fault/flags
observations and the existing C-MMU reservation/commit boundary. In particular,
INC/DEC must preserve incoming CF; failed RMW cannot publish flags or RIP.
Do not add a handler selected by this kernel coordinate.

Resource inventory: 3,674 page supplies / 3,687 resident pages; VM/cold memories
15,728,640 / 1,048,576 bytes; 8,192 physical descriptor capacity / 393,200 bytes.
The source cache has 64 rows, 6,216 metadata bytes, zero payload copies,
64,052,632 hits / 368,947 misses. The bounded engine cache compiles 368,946
modules, gets no exact-body hits, and retains 64 instances / 21,253 module
bytes. Emission 129,393,596 bytes and code recopy 1,511,206,912 bytes are
**cumulative work**, not resident memory, stored artifact or download size.
The largest measured buckets are engine replacement 33,943.2 ms, VM execution
30,237.6 ms, source/MMU admission 19,746.4 ms, then cold construction 5,993.2 ms.
These are one diagnostic run, not a controlled speed comparison or cold-ready
latency. Work remains dominated by startup loops and bounded replacement;
instruction count is not a boot percentage.

Object transport remains 47 ranges / 3,056,640 fetched bytes, 3,022,848 requested
bytes, 65,536-byte cache. This excludes fixture/module/output-digest requests;
local fixture SHA-256 is not signed-root/AEAD/ECC production admission. Dirty
recovery, full ELF/module closure, pending MSRs, remaining ISA/device/exception
semantics, PID 1/shell and development/storage/network acceptance remain red.
Human UI/native distribution were not changed; the full goal remains active.

Fresh freestanding inputs are 29,994-byte VM SHA-256
`51276cb8c154d15ae4726915dae9b06121d18fdcf3f3cac12e52afaddb86bcac`
and 417,125-byte compiler SHA-256
`398446f3c848cff8ccff31f11d3ff3722d43bfb21eb8b5dda2f769c059efbd33`.
