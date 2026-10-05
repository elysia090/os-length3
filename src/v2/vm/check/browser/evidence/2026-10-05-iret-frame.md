# IRET selector extent and fault priority — 2026-10-05

This extends [the outer-return check](2026-10-05-outer-iret.md), not the
currently running frozen startup job. VM `a59f66e` still reads five whole
qwords before CS validation. The new independent frame fixture makes it red:
at case 320 C reports #PF (115), hardware reports #GP (107) for null CS.

Build `iret-entry.S` with `as --32 --defsym FRAME_FAULT_PROFILE=1` and the
existing `exception-entry.ld`. TSS.IST1 supplies a safe fault stack; the last
frame page is mapped for construction and unmapped before IRET. This creates
two competing conditions, rather than testing missing pages in isolation.
`check-iret-system.mjs ... whpx --frame-priority` records 352 rows/23 fields.
The last field is hardware CR2. No product Linux/image or cached page is changed.

For the measured 64-bit origin, the minimal frontier is:

1. RIP qword, CS **word**, RFLAGS qword at offsets 0/8/16.
2. CS descriptor checks and Accessed update.
3. SS **word** at offset 32, then RSP qword at offset 24.
4. SS descriptor checks/Accessed, target legality, register/cache publication.

Eight-byte slot spacing does not imply an eight-byte selector load. Discarded
selector bytes must not cause a page fault. Null CS wins over absent outer
stack operands. In the valid-CS case, SS's read precedes RSP and determines
the exact #PF address. The six alignments where only the two SS bytes fit
successfully return; a whole-qword reader incorrectly faults all six.
Both models and compiled execution retain the partial CS Accessed effect.
CR2 is compared against the C fault port: architectural CR2 publication is
owned by subsequent fault entry, not by a successful source retirement.

Hardware-assisted oracle: 214 returns, 16 #NP, 16 #SS, 96 #GP, 10 #PF.
TCG: 208 returns, 32 #NP, 96 #GP, 16 #PF. **480 differing fields** remain
classified and recorded; TCG is not used to waive the hardware red.
[Hardware rows](2026-10-05-iret-frame-hardware.txt): SHA-256
e4c4dfa1025f3695e1389d3c25c564adcf01a3c9a66494aa30dcb4081d31fd36.
[TCG rows](2026-10-05-iret-frame-tcg.txt): SHA-256
4096b8ade01558e88400f7b09e98106a66ad13eee9969cd2cc026286353d15fa.
Fixture ELF: 81278c09b4b24206ceac5fb13f63f5375552fa3dd39c704278fb8810372344d8.

[Green receipt](2026-10-05-iret-frame-green.json): 120 complete CPU/cache
models, 12 fault models, 2 waits/1 stale refusal, 352 hardware comparisons,
**484 generated-Wasm/C-dispatch cases** including every hardware row. Native
`make check` and GCC ASan/UBSan pass, including 32 new frame-boundary models.
Existing IRQ and source-cohort regressions are green. No expected fault is
changed to accommodate TCG or a missing-page fallback.

VM **68,421 bytes**, +130 from the outer-return candidate; SHA-256
5b236c446143c2037e1749feaaf09e2a26d0c90495c7ce68317f4ccbc7018aed.
Compiler/ABI/imports/quotas/bundle remain unchanged. Twelve ignored selector
bytes are no longer read per ordinary return; more importantly, incorrect
faults and unnecessary residency demands are avoided, not just made faster.

Not a full fault-priority proof: all descriptor/stack aliasing, retries after
aliasing Accessed writes, nonzero-origin returns, NMI/CET and other modes
still require separate obligations. The frozen full startup job is PID 19152,
VM 68,291 bytes (`a59f66e`), compiler 450,892 bytes, unchanged warmCuts=64 /
engine 1024 entries / 262144 witness bytes. It is not restarted or replaced
by this separately compiled candidate. PID 1/shell/browser remain unachieved.
