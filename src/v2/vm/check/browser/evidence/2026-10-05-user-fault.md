# Inner fault entry through TSS.RSP0 — 2026-10-05

The completed frozen `a59f66e` run passed the previous IRET gate and reached
user instruction fetch `0x7fd6ae6b5ed9`: #PF14/error20, delivery refusal 6,
187,681,639 retirements / 98,127,488 admissions. `/init` announcement is not
successful PID 1. [Exact receipt](2026-10-05-node-startup-user-page-fault-red.json),
SHA-256 d295426127a88cde4ba5247a3f0057ae2067891f069af3b98d02ad56954f1fac.
The old receipt contains no CPU/TR-cache snapshot; none is inferred here.

## Necessary frontier, not a second execution route

For an accepted 64-bit origin, an interrupt/trap gate to non-conforming CPL0
code with IST=0 changes privilege if the interrupted CS.RPL is nonzero. Its
stack is `(TSS.RSP0 & ~15)`, not the interrupted user RSP. The processor frame
still saves the original user `(SS,RSP,RFLAGS,CS,RIP)` and an error word for
this fault. A noncanonical user RSP is not accessed by this entry.

The common C MMU owns descriptor/TSS reads, frame stores and their exact
fault/wait results. CR2 publication precedes #PF delivery/page waits. Registers,
CS/SS caches and flags publish only after all frame stores succeed; entry
does not retire the faulting instruction. The null inner SS has an explicit
ignored-cache representative. Existing FS/GS bases remain intact.

The existing 168-byte frontier retains the accepted gate, code cache, original
frame, aligned stack and count of already committed stores. Bit 8 of its
descriptor-access word pins a successful RSP0 read across later waits; low
eight bits alone are the descriptor byte. No complete CPU image is added.
TSS/frame residency waits and a frame that overwrites TSS.RSP0 before waiting
must not replay the TSS read or completed stores. The CPU/descriptor owner is
pinned while delivery is pending. Close/rebind must discard that frontier.

Reject inconsistent outer selector/cache privilege before consuming PIC.
Software entry checks gate DPL before Present. Unsupported contracts remain
explicit refusals, not a successful handler jump or instruction skip.

## Independent red and validation

Build `data/oracle/iret-entry.S` with `as --32 --defsym USER_FAULT_PROFILE=1`
and `exception-entry.ld`. Real IRET enters CPL1/2/3 and an absent executable
page at 0x300000 causes fetch #PF. The actual processor uses TSS.RSP0 and the
IDT gate. The independently recorded 27 fields include entry CS/SS/flags/RSP,
all processor-frame words, FS/GS bases and descriptor Accessed bytes.
`check-iret-system.mjs ... whpx --user-fault` exits through its success port.
QEMU/WHPX is test machinery only, not a product execution dependency.

320 hardware-assisted rows: 208 #PF, 16 #NP, 16 #SS, 80 #GP. Only the 208
actual successful outer returns/fetch faults are compared as inner entry:
CPL1/2 fetch error16, CPL3 error20, including restored noncanonical user RSP.
[Hardware rows](2026-10-05-user-fault-hardware.txt), SHA-256
b9fe544d51d65ad9b54c5ae53e4753274547643a245f74db5c34af7f5c2b0109.
Fixture ELF: 0a9b890451384059fdbf394333877fb104175a0e569c7b821e251b8467bdfa50.

`check-outer-exception.mjs` first obtains the fetch fault through actual C
`vm_code`, not a synthetic JS fault-success helper. Old frame VM returns
`6 != 0` at CPL1. [Green receipt](2026-10-05-user-fault-green.json): 208
hardware frame comparisons, complete 1,256-byte CPU/136-byte cache models,
two TSS/kernel-frame page waits. Hidden cache bits not exposed by hardware
remain models, not a bare-metal/full-cache measurement.

Native `make check` and scoped GCC ASan/UBSan pass: 96 CPL/gate/alignment
inner-fault models plus CR2/wait, TSS self-aliasing and unchanged PIC/state
refusal checks. Existing 484 compiled IRET dispatch checks (352 hardware rows),
768 interrupt transfers/288 privilege faults/96 IRQ entries, source-cohort
and 2,304 FXRSTOR direct/dispatch comparisons remain green. The earlier IRQ
regression exposed PIC consumption on an inconsistent selector/cache; its
expected result was not weakened. Whole CPU/cache comparisons
and precise fault payload assertions remain strict.

VM 68,451 bytes, SHA-256
3f9abf462f718ce8c4c3edc25b1d66f5b3294a629a84cebcc933bac65a344242.
Compiler unchanged: 450,892 bytes, SHA-256
b235e3ec3ac39db29b87acc545ea07b17c0bf3011b24e985c456c74811dd4bb6.
No new import/ABI/source metadata/quota. Native publication and human UI unchanged.

The completed older job used VM 68,291, not this candidate. Engine 9,112,171
constructions / 332,770.809 ms dominates cold 258,492.503 ms and execution
79,875.658 ms; total 826,093.361 ms. Allocated linear Memory 22,609,920 bytes
is not RSS. Different retired work/clock calibration prevents a speedup ratio.

Not closed: IST, invalid-TSS architectural exception/escalation, conforming
outer transitions, nonzero-origin IRET, NMI/CET, secondary/double/triple-fault
handling, strict CALL provenance and Linux PID1/root/shell/browser acceptance.
Outer IRQ/software entry share this inner rule, but their outer hardware
observations are not part of these 208 processor-fault cases.
