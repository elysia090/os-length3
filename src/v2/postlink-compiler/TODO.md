# Remaining work — 2026-10-04

Latest **independent Node** extended startup ends at common grammar -102 for
`movdqu (%rdi),%xmm0` (`f3 0f 6f 07`), 0xffffffff81204da1, after
160,120,102 retirements / 86,094,605 admissions. Complete decompression agrees;
NETLINK registration is not PID 1/shell. Retained-browser status remains
unobservable under URL policy; no Worker is restarted. The next common ISA
task is precise legacy 128-bit SIMD transfers, with complete native/fault/CPU
comparisons, not a VM opcode handler or skipped instruction.

The C loader now attaches the same-bundle immutable root image at the native
phram coordinate, retaining only base/length and using the existing bounded
page ticket. 100,000 extent pairs, full Linux VM core checks, scoped sanitizers
and real C-Wasm MMU/image-source checks pass. Private resident RAM writes do
not change the source image; Linux owns read-only mount and OverlayFS.
Actual Linux mounting this image, dirty persistence and browser acceptance
are still open. See [root-image evidence](../vm/check/browser/evidence/2026-10-04-boot-image.md).
The Windows RTC test now explicitly fails its unsupported libc year-9999
oracle rather than dereferencing NULL; those cases are not skipped.

Remaining measured fixed cost is repeated cold/host engine construction:
14,528,050 constructions / 14,527,298 quota evictions in that independent
run, with only 261,930 retained bytes. These measurements do not prove cold
latency or topology/work/span minimality. The strict native CALL red remains
open independently of the startup progress.

Preceding completed browser gate: `ldmxcsr 12(%rsp)` (`0f ae 54 24 0c`) at
0xffffffff81034e31, common grammar -102. The same SHLD/SHRD Worker ended
normally at 174,000,486 retirements / 96,787,852 admissions. Complete
14,622,864-byte decompression remains identical; timer/futex/NETLINK
initialization is not PID 1/shell/network acceptance. The new bounded source
lifetime VM is verified separately, not substituted into that receipt.
General LDMXCSR/STMXCSR lowering now passes 4,096 unchanged independent native
records, 16 byte-identical cold emissions, direct/C-dispatch/RF/fault models,
product checks and scoped compiler ASan/UBSan. The new real-browser Worker
uses that compiler and the verified source-lifetime VM with the same shipped
kernel and hidden-segment witness. At 147,060,462 retirements it is still
running in early Linux initialization; acceptance of the preceding MXCSR
gate and PID 1/shell remain unverified. See
[MXCSR evidence](../vm/check/browser/evidence/2026-10-04-mxcsr.md).
Host construction dominates its measured phase costs. The bounded emitted
owner now uses inline tiny Module/Instance construction at the same exact-byte
and cancellation boundary, with unchanged quotas. Browser comparison gives
71.2 -> 32.6 ms overall / 36.0 -> 18.8 ms fresh-first for fixed 238-byte C
emissions; it is not a Linux boot speedup. The native MXCSR fault matrix stays
green through this owner. Startup observations use a 1,056-byte word ring,
with unchanged default architectural/source/final-trace observations. Keep the
old Worker; the same bundle is being checked independently on the updated
owner. The saved new Worker observation is 135,060,457 retirements /
67,974,085 admissions at 0xffffffff81414d13, still running with no console
bytes or shell acceptance. Concurrent Workers are not a cold-latency benchmark. See
[construction evidence](../vm/check/browser/evidence/2026-10-04-engine-construction.md).
An intermittent native CALL oracle red is reproduced and remains open; its
expectation is not weakened and CALL lowering is unchanged.
The independent CALL minimizer now reproduces mixed post-fault payloads outside
the compiler and corrects the build-VM accelerator attribution to WHPX.
The cold output witness removes per-emission full-capacity poisoning while
retaining complete refusal checks: the independent one-million-admission
checkpoint keeps 32 architecture/source/trace/resource observations unchanged
and reduces diagnostic poison stores 116,337,168 -> 827,056 bytes (initialization
included). This is not browser speedup or PID 1/shell acceptance. The browser
URL policy prevented this turn's retained-tab observation; neither Worker was
reloaded or declared stopped. See [output witness](../vm/check/browser/evidence/2026-10-04-compiler-output.md).

Device checkpoint: binary PIT modes 0/2/6 and IRQ0 use a 128-byte C
owner with O(1) residual-phase advancement; port 0x80 owns a 2-byte POST latch.
599,808 pulse/reference and 25,728 batch/residual comparisons pass. Paused
QEMU gives 34,536 register comparisons, not an OUT/null/IRQ timing oracle.
1,868 generated CPU/segment checks and 32 mode-2 IRQ0/IRET frames pass.
C UART uses a 48-byte console byte/ticket frontier.
External output is accepted once by a bounded sink before device commit and
source retirement. Duplicate/stale/rebind/overflow, pinned source and STI
inhibition checks pass. 7,466 generated CPU/segment comparisons, all 256 byte
values and independent QEMU serial-file bytes agree. Full product checks and
C VM core sanitizers pass; previous privilege/IRQ/fault/source checks stay green.
Complete CPL/IST/debug/APIC/secondary escalation remains incomplete.

Common BSWAP lowering now passes 96 native/cold byte-identical emissions and
49,152 direct plus 49,152 C-dispatched full CPU comparisons. All sizes/GPRs,
flags, SSA-local input, prefix/refusal and RF checks pass, as do full product
checks and scoped compiler sanitizers.

Independent supervisor clock samples now reuse the same 88-byte C
ticket/generation/monotonic owner. 3,200 pure self-loop cuts and 32 boundary
PIT IRQ/IRET cases pass; private port, stale reply, source pin, rebind/reopen,
duplicate and native C/sanitizer checks pass. No kernel counter or instruction
is modified. Actual browser passes the old counter-wait quota and reaches
delay-loop calibration / CPU initialization: 138,929,830 retired,
70,626,112 admissions, 5,388 Linux console bytes and 468 external IRQs.
Complete 14,622,864-byte decompression stays identical.

FNINIT and FXSAVE now pass through common C lowering. FXSAVE uses a generic
512-byte write extent: preflight at most two physical fragments, then ordered
word stores through a 40-byte frontier, without a materialized output image.
Eight native/cold byte-identical forms pass 1,024 direct and 1,024 C-dispatch
full CPU/output comparisons, 220 fault models, 32 wait/retry observations,
88 entry refusals and eight OSFXSR profile models. All TOP/tag classes,
32/64-bit effective addresses, SS, RF and untouched software bytes are checked.
136,672 sparse-extent word comparisons, full product checks, all linked VM
core ASan/UBSan and scoped compiler sanitizers pass. Native observations use
the independent reference build VM, not a physical-CPU exception guarantee.

Actual browser passes FXSAVE and INT3, entering Linux's own vector-3 handler
at 0xffffffff810009a0. Software trap delivery now shares the 168-byte C
frame frontier: next RIP/RF=0/no error code, one retirement only after
successful delivery, original CPU on wait/fault, no completed-store replay.
All 128 independent system frames/IRETQ/RF cases include 32 previously
excluded #BP observations. Eight native/cold emission forms, 1,024 full
CPU/frame models, 64 waits/retries, 96 delivery faults and 56 entry refusals
pass, with full product/VM sanitizer and scoped compiler sanitizer checks.
Memory-source PUSH now shares ordered source-read/stack-write SSA through
the existing C access boundary; it observes old RSP and publishes no CPU
or retirement before success. 28 native/cold byte-identical forms give
3,584 full CPU/RAM observations including 1,648 faults, plus 168 waits/retries
and 18 executable-alias models. Product/scoped compiler sanitizers and fresh
POP/CALL/LEAVE regressions pass. No VM opcode handler is added; compiler
growth is 108 bytes. Actual browser passes PUSH and logs early rootfs
initialization (`VFS: Finished mounting rootfs on nullfs`), not PID 1/shell
or a mounted release root. That run's next common gate was `sarq %cl,16(%rsp)`
(`48 d3 6c 24 10`) at 0xffffffff81086ff7: 144,754,379 retired / 75,002,351
admissions and 5,717 console bytes. Counts depend on calibration and are
not percentages or speedups. HLT wake, PID 1/shell and the full goal remain
red. Native bundle and human UI remain unchanged.

Memory SHL/SHR/SAR/ROL/ROR now share the existing register value/flag SSA and
C-MMU RMW reservation/commit. 340 native/cold byte-identical forms give
174,080 full CPU/RAM comparisons in direct Wasm and separately C dispatch,
including 34,240 fault frames and 6,740 masked-zero write faults. 1,360
waits/retries, 1,700 entry refusals, 20 executable-write models, full product
checks and scoped compiler ASan/UBSan pass. Undefined flags are masked for
native equivalence; the compiler's zero representative is checked separately.
266 register modules remain byte-identical after extracting the shared emitter.
No VM opcode handler or payload image is added; compiler growth is 171 bytes.
The actual browser passes memory SAR and stops at `shrdq $32,%rdx,%r11`
(`49 0f ac d3 20`) at 0xffffffff8108700f: 144,564,477 retired / 74,868,147
admissions, 5,717 console bytes and 3,422 external IRQs. Full decompression
remains identical. Early rootfs initialization is not PID 1, a release root
mount or an offline shell. Native bundle and human UI remain unchanged.

SHRD/SHLD now share general three-input SSA and the same C RMW boundary.
222 forms pass 113,664 direct and 113,664 C-dispatch CPU/RAM observations,
11,040 fault frames, 2,284 zero-count write faults, 408 waits/retries,
990 entry refusals and six executable-write models. All CL counts, immediate
edges, sixteen value edges, source/destination/count aliases, ADD flag
predecessors and CF/ZF/OF consumers are covered. 12,516 undefined low
destinations use the explicit zero representative, not a hardware claim.
9,792 GPR/count/memory grammar bindings, full product checks and scoped
compiler ASan/UBSan pass; prior 340 memory shift/rotate emissions remain
byte-identical and pass their 174,080 direct/C-dispatch comparisons.
Compiler growth is 1,578 bytes; VM/native bundle/human UI are unchanged.
The earlier saved running browser observation was at 152,060,467 retirements /
80,429,141 admissions, early rootfs initialization but no PID 1/shell.
The saved running observation is not a terminal SHRD/next-gate acceptance.

The next bounded C source-owner correction passes a hot/cold red-to-green:
the previous round-robin owner recompiles a repeated valid hot source 64
times among 4,096 cold demands. Validated demand now refreshes a fixed
64-rank list; free ranks precede the oldest demand, with no epochs, copied
payload, growing history or quota increase. Failed cross-page tail admission
does not refresh it. 20,000 independent reference/write/reset cases, prior
100,000 replacement cases, 4,096 crossing demands and 512 cold + 512 hot
complete C-Wasm CPU dispatch comparisons pass. VM core ASan/UBSan, product
checks and memory-shift/double-shift/IRQ/trap/REP regressions pass. Metadata
grows 128 bytes; candidate vm.wasm grows 246 bytes. This is not global
quotient minimality or a measured browser speedup.
The same 1,000,000-admission diagnostic has 1,773 rather than 1,967 cold
requests, but engine constructions remain 1,211. The largest cost is not
therefore solved. This candidate did NOT replace the preceding browser Worker.
An intermediate unchanged-Worker receipt is at 166,437,849 retirements /
91,155,901 admissions, with devtmpfs, timer/futex initialization and NETLINK
registration, not PID 1/shell or usable network. See
[source lifetime evidence](../vm/check/browser/evidence/2026-10-04-source-lifetime.md).

Next, in order:

1. Observe the in-progress new real-browser Worker beyond the preceding
   LDMXCSR gate. Use its bounded absent-key/changed-body/eviction counters
   to identify actual engine fixed costs, not inferred cold/boot speedups.
   Close its next general ISA/MMU/device red with independent observations
   and shared C lowering, never an opcode skip or Linux-function case.
   Never replace an in-progress Worker on an observation timeout.
2. Continue the same shipped bzImage through common ISA/MMU/device admission
   to actual PID 1/shell, then C compile/run, make -j4, local Git and apk.
3. Complete authenticated delivery/workspace recovery and granted virtual-NIC
   HTTPS/service use, preserving Linux as the only syscall/VFS/net authority.
4. Minimize the independently reproduced CALL oracle red: target #GP sometimes
   leaves the reference stack word unchanged. Full product runs pass and fail;
   194 isolated repetitions passed before repeat 195 failed in form 23/row 81.
   Diagnostics expose inputs/frame/source bytes; do not hide this with a
   retry-as-success, expectation relaxation, or product semantic change without
   independent evidence. See the source-lifetime evidence's known-red section.
   The standalone minimizer now reproduces it without any product/compiler:
   52 untouched stack words among 884,736 WHPX observations, with unchanged
   GPR/RSP/RIP frames. Explicit TCG retains the payload in 110,592 observations
   but reports advanced RSP/RIP instead. Do not use that as full equivalence or
   relax the existing check. Accelerator attribution is corrected; see
   [independent CALL receipts](../vm/check/browser/evidence/2026-10-04-call-fault.md).

Engine candidate identity is separate from source placement: exact newly
emitted bytes permit 1,573,491 hits, construction 1,823,976 -> 250,466 and
engine phase 153,360.5 -> 33,796.7 ms in two actual runs. Emitted-witness cap
stays 256 KiB; no total engine-RSS cap is claimed. The previous completed browser
run is dominated by engine construction (373,684.7 ms), cold emission
(73,707.8), C execution (51,371.4) and admission (27,855.5). Source copying
is 26.73 GB cumulative, not simultaneous RAM. Exact-byte hits now refresh
bounded engine demand lifetime; hot/cold component tests were red then green
at unchanged quotas. This is not a measured browser speedup. Profile absent/
evicted bodies versus changed emissions before altering physical identity or
claiming construction eliminated. An earlier running receipt constructed 4,148,301
engines with 2,363,249 exact-byte hits. Diagnostic progress is read-only.
Cold shell 3 seconds remains unmet.
An intermediate receipt from the now-completed preceding Worker has 9,441,889 engine constructions / 2,503,869
exact-byte hits; engine 844,460.6 ms dominates cold emission 142,221.8,
C execution 75,995.2, admission 34,927.8 and supply 247.3. That was a running
observation, not a completed latency result. Three bounded counters for absent
keys, changed bodies and quota eviction are component-tested, but were added
after this Worker loaded and are not actual measurements from it. Measure
them only in a fresh run; the previous Worker has now terminated normally.
See [current evidence](../vm/check/browser/evidence/2026-10-04-double-shift.md).

## Immediate delivery and next product goal — 2026-10-02

The public download/product name is `os-length3-linux`. Older `qm-linux`
filenames in raw verification receipts identify historical candidates;
they are not the new Release asset name.

1. The full refactored-compiler re-bake is complete: 199 ELF calls, kernel
   proof, 45 installed packages, package/resource closure, extracted C/make,
   upstream development and certificate-verified Git/HTTPS are green.
   The exact new kernel/root passed PID 1/services, offline shell, C/make -j4,
   Git/AES/apk and COW in QEMU TCG (one ready observation: 1,826.0 ms).
   The new download is 63,219,311 bytes, publication `1a0bddc2340a...`,
   optimized package identity `cc18062ec832...`. All 383 ELF and 31 archive
   paths match the previous executable bytes; the prior timing result is
   retained, not relabeled as a new benchmark. Published as
   [OS Length3 Linux 0.1.0-rc.1](https://github.com/elysia090/libqm-prototype/releases/tag/os-length3-linux-v0.1.0-rc.1)
   with SHA256SUMS, all 48 authenticated source inputs, decoder submodules,
   build/configuration/patch/compiler sources and honest candidate limitations.
   All four GitHub asset sizes/digests match the local bytes. The source/evidence
   is in PR #14; binary archives remain outside Git. The small benchmark
   difference remains accepted for this stage, not relabeled as a speedup.
2. The next goal is **the same shipped bundle running on Wasm in a real
   browser**. Preserve its release/root/optimized-ELF identity. Connect the
   optimized-x86 reader, Wasm compiler, machine ABI, VM and authenticated
   Artifact/Storage supply; do not reconstruct a separate browser distribution.
   Linux remains the only authority for syscalls, VFS, processes, signals,
   credentials, sockets and time. JavaScript supplies UI, delivery and granted
   host events, not an x86 interpreter or POSIX implementation.
3. Browser acceptance: authenticated cold open -> included Linux/PID 1 ->
   offline terminal -> C compile/run -> `make -j4` -> local Git -> package
   queries; with a grant, certificate-verified curl and Git HTTPS. Compare
   guest-visible results with the native bundle, record first-use fetches,
   resident memory, missing/unsupported execution coordinates and cold-ready
   time. No unsupported coordinate may silently change semantics. Worker
   disposal/reopen must retain committed workspace data. A 3-second cold
   shell remains a measurement target, not an already achieved browser claim.

The older ordered witness list below is a diagnostic backlog, not permission
to postpone the next browser product goal behind new native size/speed work.

## Active browser work — 2026-10-03

Goal: the same published native bundle -> independent C cold compiler ->
C vm.wasm -> real-browser Linux/PID 1/offline shell -> C compile/link/run,
make -j4/local Git/apk, then authenticated storage/workspace recovery and
granted virtual-NIC HTTPS/Git/service use. Linux remains the sole semantic
authority. No source interpreter, opcode skip or fallback is permitted.
Native release and human UI stay unchanged. Cold shell 3 seconds is unmet.

Previous executable checkpoint: common REP STOS, memory-source
ADD/SUB/AND/OR/XOR and register CMOVcc are implemented and verified against
actual x86. STOS passes all 8/16/32/64 widths and 32/64 address sizes, DF,
zero-count, partial/cross-page faults, code aliases and bounded continuations;
only RCX/RDI publish on partial return. Memory-source ALU passes 26 modules /
13,312 complete CPU/RAM comparisons; CMOV passes 51 modules / 26,112 comparisons
in direct Wasm and separately C dispatch, including false 32-bit parent zeroing
and interior flag consumers. 431 native/cold emission comparisons, full product
check and selected compiler/lowering ASan/UBSan pass. Previous JMP/REP/RMW
regressions remain green; linked decoder/provider archives in the sanitizer
run are normal builds, not whole-TCB coverage.

Previous executable checkpoint added common near indirect CALL and register
BT/BTS/BTR/BTC. CALL passes 27 native/cold byte-identical modules and 6,912
actual x86 CPU/stack comparisons (2,150 exception frames), including 448
target-#GP cases whose return-address payload store survives while CPU/RSP/RIP
remain unchanged. Target reads precede stack stores; stack faults precede the
target check. Register bit operations pass 60 post-linked ELF modules / 30,720
cases in direct Wasm and separately C dispatch, including narrow parents,
modulo-width indexes, self-aliases and an interior CF consumer. Full product
check and selected compiler/lowering ASan/UBSan pass.

Previous checkpoint adds common register ADC/SBB and memory-source CMOVcc.
ADC/SBB passes 66 ordinary post-linked modules / 33,792 native comparisons,
and separately C table dispatch, including both carry inputs, width-specific
boundary pairs, high bytes, self aliases and CF consumers before later kills.
CMOV memory passes all 16 conditions at 16/32/64 bits, plus address aliases,
address-size 32, SS, SIB, extended GPR and RIP forms: 54 modules / 27,648 complete
CPU/RAM comparisons. 27,136 actual protection faults, including false conditions,
match the C MMU's pending fault and unchanged CPU. No exception-entry claim.
Full product check, selected compiler/lowering ASan/UBSan and previous CALL/JMP
regressions pass; 238 new native/cold emission comparisons and 203 previous
CMOV/bit/memory-ALU comparisons are byte-identical. Sanitizer-linked decoder/
provider archives remain normal builds, not whole-TCB sanitizer coverage.

The actual ordinary-memory browser Worker executes 368,735 source instructions
with 284,606 demanded admissions, one active table slot and no manually listed
branch coordinates. The complete independent 86-instruction CPU/cache and
378-instruction relocation-register witnesses, all 3,040,256 copied kernel
bytes, 98,656 REP BSS bytes and three scalar memset returns totaling 131,104
bytes pass. The count is predominantly memset iterations, not a boot percentage.
The previous SBB and memory CMOVE at `0x1e21078` both compile and execute.
The next red is pending #PF(2), fault address `0x1000000`, at `0x1e21913`,
`MOV [r10],r14b` (`45 88 32`), CR3 `0x1e41000`. The exact Linux 7.2.7 upstream
source installs `boot_page_fault` in stage-2 IDT; `do_boot_page_fault` maps the
non-present 2 MiB identity range. Deliver that guest exception, not a JS page
table repair. Older port request `0x1e60000` is not this fault address.
Neither the instruction count nor passing component checks establish Linux boot.

Current checkpoint closes that #PF through common CPL0 long-mode IST=0
IDT/code/stack/flags/CR2 delivery and cold compiled IRETQ. Linux's own handler
maps the missing range and resumes decompression. Actual browser: 1,616,430
retired / 1,000,000 admissions, stopped only by the diagnostic quota. 96 QEMU
TCG system-oracle #PF/#UD/#GP frames, native C/C-Wasm entry, compiled IRETQ and
following RF clears pass; this is not physical-hardware or complete exception
coverage. Full product checks and all linked C VM core ASan/UBSan pass.
Fresh control, carry dispatch and memory-CMOV/fault regressions are green.
TSS/IST, outer returns, #DF/triple fault, IRQ/NMI/debug and complete IRET fault
ordering remain open. The event frontier is 160 bytes, not a CPU snapshot;
completed aliasing frame stores are not replayed after a residency wait.

Current source-admission checkpoint removes repeated transport/construction:
64 C-owned exact physical source extents, 6,216 bytes metadata, zero source
payload copies. Every lookup still executes the C MMU; RAM/A/D/reservation
writes invalidate exact intersections before mutation. Pending compilation
pins the whole source page; any write cancels publication. Native 100,000
replacement/collision and actual PML4-alias/#PF cases, ASan/UBSan and six real
C-Wasm compile/install/reuse cases pass. Private callback-slot overlap was red
in the actual browser and is now covered. The same 1,616,430-retirement CPU
quota state uses 1,967 compilations / 998,033 source hits, 8,056,832 cumulative
code-copy bytes instead of 4,096,000,000; fetch/residence are unchanged. Timing
observations are not cold-shell latency. No native release/human UI changed.

Previous common-path checkpoint: MISC_ENABLE/effective CPUID, all six implicit
sign extensions, precise 8/16/32-bit register DIV/IDIV and immediate memory
BT/BTS/BTR/BTC are implemented. 316 fresh native/cold emissions, full product
checks and selected lowering ASan/UBSan pass. Division matches 12,288 native
CPU observations / 7,661 #DE frames in direct Wasm and separately C dispatch;
memory bit operations match 9,216 CPU/RAM / 8,704 protection-fault observations
through C-MMU (not a separate exception-entry completeness claim). QEMU's
MISC oracle does not prove its missing CPUID side effects. Pending/unsupported
families are still explicit, not skipped or mapped to a guessed fault.
Actual browser adopts Linux's own high virtual mappings and reaches
129,063,662 retirements / 64,421,578 admissions. Six #PFs enter and return from
guest handlers; output still matches all 14,622,864 decompressed bytes.
That run stopped at memory INC. See [its evidence](../vm/check/browser/evidence/2026-10-03-misc-arithmetic.md).

Previous checkpoint closes common 8/16/32/64-bit memory INC/DEC/NEG/NOT, with
precise existing C-MMU reserve/commit and incoming-CF preservation for INC/DEC.
22 post-linked forms pass 11,264 CPU/RAM / 10,240 actual protection-fault /
21,504 RF checks; fresh CMOV fixtures also pass. The subsequent first-instruction
page-boundary entrance defect is closed through a compiler FETCH demand and
C-MMU-only tail admission, not speculative next-page fetch. Cached crossings
revalidate both owners. Source metadata is now 6,752 bytes / 64 rows / zero
payload copies. Exact writes, two non-contiguous owners, NX/nonpresent/residency,
remap, pending page-wide cancellation, A-bit table aliases and generation/grow
are checked in the actual C-Wasm owner/dispatcher. Full product checks, all
VM-core ASan/UBSan, selected lowering sanitizers and 338 native/cold byte-identical
emissions pass. Actual browser executes 129,071,601 instructions / 64,425,459
admissions with unchanged full decompression output. The next -102 is ordinary
memory CMPXCHG at `0xffffffff81096d52`; it has not retired. PID 1/shell remains
red. See [current evidence](../vm/check/browser/evidence/2026-10-03-memory-unary-source-tail.md).

Previous checkpoint closes common scalar memory CMPXCHG, LOCK/no-LOCK at all
four widths, preserving the native typed descriptor and lowering its exact
meaning to SSA plus existing C-MMU reserve/commit. Both comparison arms write;
faults publish no CPU state. LOCK is closed only for the synchronous serialized
ordinary-memory owner, not SMP; provider and generated modules reject shared
memory linking. 32 post-linked forms pass 16,384 CPU/RAM / 14,848 native
protection-fault / 31,232 RF checks. Four source-alias compare/exchange cases
also retire once through C dispatch and invalidate even equal-byte writes.
Full product checks, selected lowering sanitizers and 370 native/cold emissions
pass. Actual browser: 129,078,646 retired / 64,428,968 admissions, unchanged
complete decompressed output. The next -102 is memory SETE at
`0xffffffff81096421`. PID 1/shell remains red.
See [current evidence](../vm/check/browser/evidence/2026-10-03-memory-exchange.md).

Previous checkpoint closes all 16 memory SETcc conditions through common condition
SSA and the existing C-MMU byte store. 32 entrance cases were red, then green;
25 post-linked forms pass 12,800 CPU/RAM / 12,288 native protection-fault /
25,088 RF checks. Both truth values write, flags/GPRs are unchanged and failures
do not publish RIP/retirement. Two source-alias cases separately retire once
through C dispatch and revoke even equal-byte false writes. Full product check,
selected lowering sanitizers and 395 native/cold emissions pass. Actual browser:
129,387,892 retired / 64,571,332 admissions, unchanged full output. Next -102:
register-index memory BTS at `0xffffffff81054a7c`. PID 1/shell remains red.
See [current evidence](../vm/check/browser/evidence/2026-10-03-memory-condition.md).

Latest checkpoint closes ordinary signed register-index memory BT/BTS/BTR/BTC
through address SSA and the existing C-MMU read/reserve/commit. 24 entrance
assertions were red, then green. 38 post-linked forms pass 19,456 CPU/RAM /
17,408 native protection-fault / 36,864 RF comparisons; signed floor division,
all widths/address sizes and shared bit/SIB indexes are covered. Four actual
cold signed BT/BTS source-alias cases separately run C dispatch, including an
unmapped original base and equal-value write fencing. Full product check,
selected lowering ASan/UBSan, fresh immediate-bit regressions and 433
native/cold byte-identical emissions pass. Source admission now performs 20
actual cold emissions. Native bundle and human UI are unchanged. Actual
browser: 129,394,681 retired / 64,574,988 admissions; decompression witnesses
are unchanged. Next -102: `f3 48 0f bc c9` at `0xffffffff813e188f`. The fixed
CPUID profile has no BMI1/LZCNT: close the legacy scan encoding contract before
lowering the corresponding pure summary. Do not silently publish TZCNT flags
or widen CPU features. PID 1/shell and the full product goal remain red.
See [current evidence](../vm/check/browser/evidence/2026-10-03-memory-index.md).

Latest checkpoint closes profile-bound register BSF/BSR and POPCNT through
masked SSA and Wasm ctz/clz/popcnt. The decoder implementation remains single;
native post-link retains superset semantics, while formation/flag analysis/emit
all use the immutable-profile view. 24 decoder and 15 pure entrance cases
pass; 75 ordinary post-linked forms pass 38,400 comparisons in direct Wasm
and separately C dispatch. Thirty F3 modules use explicit unprefixed native
twins because clear CPUID did not make the TCG oracle execute legacy scans;
312 zero-source destination checks enforce a chosen undefined representative.
Full checks, selected decoder/lowering ASan/UBSan, 508 native/cold emissions
and all 20 source-admission regressions pass. Actual browser: 129,396,286
retired / 64,576,209 admissions, unchanged complete decompression output.
Next -102 is `66 c1 c0 08` (ROL AX,8) at `0xffffffff8103acc0`.
PID 1/shell and the full product goal remain red.
See [current evidence](../vm/check/browser/evidence/2026-10-03-summary.md).

Latest checkpoint closes common register ROL/ROR through exact periodic-word
SSA and native Wasm rotate. 48 entrances were red, then green; 110 ordinary
post-linked forms pass 56,320 comparisons in direct and separately C dispatch,
with correct masked count versus modulo-width rotation, all widths/aliases,
CF/OF definedness, predecessor flags and interior consumers. Fresh 156 shift
regressions, full product check, selected lowering ASan/UBSan, 618 native/cold
emissions and all 20 source-owner regressions pass. Actual browser:
129,965,641 retired / 64,842,476 admissions, unchanged complete decompression.
Next -102 is `8c d0` (MOV EAX,SS) at `0xffffffff814045bb`.
PID 1/shell and the full product goal remain red.
See [current evidence](../vm/check/browser/evidence/2026-10-03-rotate.md).

Next, in order:

1. Actual browser decompression is now completely observed: all 14,622,864
   bytes / 3,571 pages match an independent gzip CRC/ISIZE-validated output,
   before Linux's own PT_LOAD moves. The guest then executes the ELF entry
   0x14015e4. Common 16/32/64-bit two/three-operand register IMUL closes the
   preceding real red at 0x1e23d8b; 32 ELF modules / 16,384 actual x86 cases
   pass in direct Wasm and separately the C dispatcher. Full product checks,
   selected lowering ASan/UBSan and 98 native/cold byte-identical emissions pass.
   Common WRMSR/RDMSR/SWAPGS now close that actual WRMSR, through the existing
   hidden FS/GS cache and EFER owner, with known inactive kernel-GS only in the
   MSR bank. No duplicate dictionary/default-zero path. Full checks, 1,152 C
   and 2,156 C-Wasm model cases, 32 legal QEMU TCG rows / 160 comparisons,
   250 native/cold byte-identical emissions and selected ASan/UBSan pass.
   Privilege/reserved/noncanonical faults are model-tested, not system-oracle
   proved. Actual browser reaches 129,057,505 retirements / 64,417,792 admissions;
   Common 16/64-bit LEAVE now closes the following stop: six native forms /
   1,536 complete CPU/RAM observations / 490 #SS/#PF frames match direct Wasm
   and separately C dispatch, including cross-page/protection and preserved
   state on faults. Full checks, 256 native/cold emissions, selected ASan/UBSan,
   RF clearing and physical waits pass. No warning, interpreter or skip.
   Prior browser: 129,057,543 retirements / 64,417,818 admissions; next RDMSR
   at 0x102dcc6, ECX=0x1a0 (Intel MISC_ENABLE), result 6. The initial wrong
   #GP for this available-but-unimplemented MSR is fixed; TSC/SYSCALL/MISC
   pending keys refuse explicitly, not an invented guest fault/default zero.
   MISC_ENABLE/CPUID and subsequent arithmetic/bit cuts are now closed as
   described above. Memory unary and demand-driven first-instruction tails are
   now closed as well, followed by scalar memory CMPXCHG, memory SETcc and
   ordinary signed register-index memory BT/BTS/BTR/BTC.
   Profile-bound legacy scan/count semantics are now closed as described above.
   Common register ROL/ROR and visible selector reads are now closed through
   shared SSA/parent/C-MMU paths. 72 selector entrances were red, then green;
   36 register / 39 memory forms pass native/C-dispatch/C-MMU and independent
   guest-selector model comparisons. Full checks, selected lowering sanitizers,
   693 cold emissions and the 20 source-owner regressions pass.
   Common INVLPG now closes through the tested absence of TLB/walk caches,
   preserving its privilege fault, precise cut and normal retirement. 84
   entrances were red first; 11,424 direct model cases, 84 native CPL3 #GPs,
   1,008 QEMU TCG CPL0 observations and 66 C-Wasm MMU/fetch cases pass. 256
   large-page/PGE/global remap rounds supplement the old MMU permission matrix.
   Full checks, all C VM core sanitizers, selected lowering sanitizers, 777 cold
   emissions and all 20 source-owner checks pass. A retained translation cache
   would require changing both this lowering and the MMU contract.
   The F0000 physical-source witness is now closed by an explicit erased ROM
   resource for the direct-entry machine, not RAM, BIOS services or a guest
   patch. ROM writes/RMW discard only immutable fragments after guest paging
   rights; RAM fences remain. 12,000 arbitrary C cases, 188 actual C-Wasm
   cases and 17 independent QEMU ROM-bus rows match. Full product checks,
   all C VM core ASan/UBSan and 20 source-owner regressions pass. Unassigned
   A0000/BF000/out-of-RAM supply still refuses, without fabricated pages/#PF.
   Previous real browser: 130,560,760 retired / 65,228,266 admissions; eight #PFs
   and six #GPs enter Linux handlers, unchanged complete decompression output.
   Its next compiler refusal was `0xffffffff81033a58`, `8f 04 24` (POP [RSP]).
   Common memory POP is now closed with ordered read/store SSA, post-increment
   destination and native/C-MMU fault, alias, retry and RF witnesses. Full checks,
   selected sanitizers, 801 cold emissions and 23 source-owner emissions pass.
   General scalar IN/OUT and RDTSC now use generated C imports, precise TSS
   bitmap permission reads and identity-bound clock wait/reply/consume. Binary
   PIT mode 0 is supported; other modes/BCD/string I/O/undeclared devices and
   TSC MSR access refuse. The diagnostic samples active C execution time, not
   source count or compile/delivery stalls; IRQ/RTC/recovery remain incomplete.
   Full checks, C VM core/selected compiler sanitizers, 827 cold emissions and
   3,328 actual C-Wasm I/O/time observations pass (model, not hardware oracle).
   Actual browser reaches 134,155,429 retired / 67,443,593 admissions, 13 clock
   events and unchanged complete decompression/delivery. This does not prove
   the selected Linux calibration frequency. Next actual refusal is memory
   IMUL RAX,[RIP+0x751f64],24 (`48 6b 05 64 1f 75 00 18`) at
   0xffffffff81419204. That common connection is now closed: 57 native fixtures,
   29,184 complete successes / 28,160 #PF frames, actual C-MMU and 57,344
   separate C-dispatch comparisons, selected sanitizers and 916 cold emissions.
   Actual browser now reaches 134,840,258 retired / 67,826,812 admissions;
   complete decompression/delivery are unchanged. Next is 64-bit IDIV RDI
   (`48 f7 ff`) at 0xffffffff81413f53. Extend existing register division to
   precise full 128/64 quotient/remainder/#DE, not a coordinate shortcut or
   only sign-extended dividends. The C device owner and fixed profile stay intact.
   That general division entrance is now closed: 32 native/cold modules,
   16,384 complete native observations / 10,348 #DE frames in direct Wasm and
   separately C dispatch, 1,140 algebraic full-width boundaries, selected
   sanitizers, full checks and 924 cold emissions. Browser advances to
   134,840,569 retired / 67,826,980 admissions. Next is `48 f7 e2` (MUL RDX)
   at 0xffffffff810ab884. That common implicit product entrance is now closed:
   register/memory MUL and one-operand IMUL use the shared high-limb SSA;
   38 register modules / 19,456 native cases and 46 memory modules / 23,552
   successes / 22,528 #PF frames pass direct and C-dispatch comparisons.
   Full checks, selected sanitizers and 1,008 cold emissions pass. The actual
   browser now reaches 136,073,617 retired / 68,669,194 admissions. Next is
   `f7 7c 24 04` (IDIV dword [RSP+4]) at 0xffffffff81008e75: connect all
   ordinary memory DIV/IDIV source widths to the existing precise division
   SSA after a C load, proving #PF priority before #DE and no early register
   publication. No kernel-coordinate arithmetic or interpreter fallback.
   This common memory division entrance is now closed: 72 native/cold modules,
   36,864 native observations / 19,598 #DE / 36,864 #PF frames,
   C-MMU/dispatch/wait/retry/RF/refusal checks, full checks, selected sanitizers
   and 1,080 cold emissions pass. Actual browser advances to 136,129,036
   retired / 68,707,852 admissions. Next is `83 54 24 70 00`, ADC dword
   [RSP+0x70],0, at 0xffffffff81203942. This general memory ADC/SBB entrance
   is now closed through shared carry SSA and precise reserve/commit: 132
   native/cold modules / 67,584 CPU/RAM observations / 59,392 protection faults,
   separate C dispatch, RF, 264 waits/retries and 18,944 independently readable
   write-fault witnesses pass. Full checks, selected 52-fixture sanitizers and
   1,212 cold emissions pass. Actual browser reaches 136,209,125 retired /
   68,765,994 admissions. Next -102 is `0f 01 44 24 0e`, SGDT [RSP+0xe], at
   0xffffffff8103af89. This common SGDT/SIDT entrance is now closed through
   the existing table owner and ordered two/eight-byte stores. Actual native
   #PF observation disproves a whole-record write preflight: the earlier
   limit can survive a later base fault. A 104-byte C-owned next-store frontier
   retains no CPU snapshot and is pinned across physical waits. Ninety-six
   native/cold forms, 16,128 state/dispatch models, 108 unique actual native
   observations, 216 waits/retries, 2,244 refusals and 108 ordinary-abort
   preservations pass. Native row uniqueness first caught a truncated-stack
   reference capture and stale siglongjmp; corrected capture and full-grid
   validation supersede that defective receipt. Full checks, all VM-core /
   selected lowering sanitizers, 1,308 cold emissions and prior carry/divide/
   IO/source/supply regressions pass. UMIP models do not widen the CPU profile.
   The subsequent LTR AX at 0xffffffff8103afa1 is now closed through the common
   LLDT/LTR register/memory entrance and C hidden-segment owner. Whole-record
   descriptor RMW precedes busy TR/cache publication. All 144 compiler forms,
   8,274 C models, 153,360 C-Wasm models, 144 waits and 3,024 actual system-oracle
   comparisons pass; 48 QEMU legacy-TSS differences remain explicitly modeled.
   The first full check exposed an intermittent pre-existing native CALL
   observation; four isolated repeats and the full retry passed, but its
   cause remains unresolved. All VM-core / selected lowering sanitizers and
   current 438 cold emissions pass. Actual browser reaches 136,209,819 retired /
   68,766,303 admissions and next stops on WRMSR IA32_STAR (0xc0000081) at
   0xffffffff8103adf2. This is C ENTRY_MAP (6), not a compiler refusal or guest
   #GP; the displayed port fault fields are stale from an earlier exception.
   STAR/LSTAR/CSTAR/SYSCALL_MASK are now closed through the same C MSR owner,
   with one six-rank prefix and consistent generated CPUID resume validation.
   New tests were red first (957 assertions); 2,388 C / 3,513 C-Wasm models,
   60,032 CPUID CPU comparisons / 60,046 refusals and 622 cold emissions pass.
   The 288-row actual system oracle matches 194 rows and explicitly retains
   94 QEMU/Intel reserved/canonical differences; this is not hardware fault
   proof. Full checks and VM-core / selected full-lowering sanitizers pass.
   Actual browser reaches 136,211,240 retired / 68,767,197 admissions and next
   refuses MOV DR7,RAX (`0f 23 f8`) at 0xffffffff8103b125, RAX 0x400. This is
   compiler GRAMMAR (-102); the decoder already types the debug-register
   family. Close the common read/write debug boundary and precise privilege,
   reserved/alias/GD fault behavior with system-oracle reds. Do not publish
   fixed Linux DR state or ignore debug faults. Syscall/TSS/IST execution
   remains separately open; no skipped instruction or profile expansion.
   See [current evidence](../vm/check/browser/evidence/2026-10-04-syscall-msr.md).
   Do not treat the
   bounded 128/64 divider as a global work/span-minimum proof. Memory division
   is now compiled through the same arithmetic after a C read. Boot/PID 1/shell remain unmet.
   The old linked System.map is not the optimized address authority.
   Keep the CPU profile/native bundle unchanged and precise C-MMU ownership intact.
   Do not patch the guest, change CPU signature or add kernel-coordinate code.
   PID 1/shell are still not achieved. Prior MSR/LEAVE evidence stays historical.
   Engine replacement, VM execution and source/MMU admission still dominate
   the recorded uncontrolled observations. Other checks overlapped;
   these are not a controlled speed comparison or cold-ready measurement.
   Engine reuse reports zero hits / over 1.2 million compilations, despite bounded
   64-module residency. Analyze exact
   instance/topology sharing and C-owned multi-cut dispatch rather than grow
   an unbounded cache or skip validation. Use the current C-owned source
   admission, never a JavaScript source cache. Preserve demand-only crossing
   supply and precise fetch ordering. Preserve source/compiler/engine lifetime
   and alias invalidation; concurrent admission/remap is not implemented.
2. Expand exception/IRET fault-priority and privilege/TSS/IST coverage as actual
   startup demands it, using common system-oracle witnesses. Physical absence
   is a host wait; a guest non-present PTE is a Linux fault. Never overwrite
   guest mappings, skip faults or install a host-selected handler. Secondary
   delivery faults currently stop explicitly; #DF/triple-fault remains open.
3. Finish actual kernel startup, MSR/device/root supply, then
   Linux/PID 1/shell and the complete development/storage/network acceptance.
   Whole-image `-104`, boot, cold shell and production admission remain red.

Physical supply remains one unsorted C index, never VM reopen/reset or a JS
MMU. Latest extended browser: 3,697 page supplies / 3,710 resident pages, 49 HTTP 206
ranges, 65,536-byte chunk cache, 15,728,640 VM memory / 1 MiB cold memory.
The default 1,000,000-admission / 2,000,000-retirement diagnostic stays small;
`?budget=extended` now selects 150,000,000 / 300,000,000 and at most 32 MiB memory.
Progress messages retain the same Worker; they are not persistence checkpoints.
The ordinary small profile stays unchanged. The output oracle is a diagnostic
page-hash list, never decompressed bytes fed into guest memory or execution.
Quota/capacity exhaustion is not boot success. Local chunk SHA-256 does not establish
signed-root/AEAD/ECC admission. Dirty eviction/recovery and general concurrent
admission remain open. See
[the current evidence](../vm/check/browser/evidence/2026-10-03-pop-memory.md)
and the historical condition/flags/REP/JMP receipts linked from BROWSER.md.

Follow [BROWSER.md](../docs/BROWSER.md). The new blocker is actual backend
implementation, not the minor native benchmark difference: whole-image Wasm
function/module/dispatch closure returns `WASM_COMPILER_ERROR_INCOMPLETE`, the complete
machine/exception/device boundary is missing, and the old terminal names an artifact outside the
current catalog. Do not re-enable that historical input as a shortcut.

First establish real-browser capability probes and a built CLI/executable
projection red gate, then implement cold accepted-x86 lowering and the C
machine boundary. Single-worker wasm32 with bounded physical residency is the
baseline; memory64, shared workers and network grants do not gate offline boot.
Executable generation from C/as/ld and kernel patching needs compile admission,
not an interpreter or a pre-enumerated list of future user programs.

Boundary checkpoint: the user-supplied ordinary-memory browser probe passed
two successive Workers, the i64/memory/table ABI and an eight-byte Range read.
The isolated browser and RSS reclamation are not measured. The built Wasm CLI
accepts the shipped BusyBox proof but rejects executable emission with `-104`;
this remains a real red gate, not a browser boot. Rejected reopen now clears
all previously admitted ELF state; its regression first failed and then passed.

Expanded browser success condition: boot is only the entry gate. The same Linux
workspace must use encrypted page-native local/remote storage, explicit selected
file import/export, revocable NIC/gateway connectivity and publication of a
chosen guest service to a real browser URL. Browser consent, grant revision,
machine generation and durability/root receipts have distinct lifetimes. See
BROWSER.md's acceptance matrix; no QEMU feature-superset or raw-socket claim.
The small C resource gate now passes stale/duplicate/cancel/revoke, range/budget,
authority-restart, lane-alias and exhaustion tests, including 100,000 cases and
ASan/UBSan. Root product checks also pass. A two-lane equal-sequence reply first
failed; the complete ticket address now includes lane rank. API inventory is
passive, requests no browser consent and reports no connection as usable.
This control boundary does not make whole-image executable lowering, exception
delivery or virtio implementation green. The next implementation remains accepted-x86
lowering and C machine/device integration, then binding these resource lanes to
real encrypted storage, file transfer and NIC/publish adapters.
NETWORK.md now separates guest MTU from carrier datagram budget: the unimplemented
C frame bridge must support bounded below-IP fragmentation, not disable IPv6 by
shrinking its link below 1280 or quietly move packets onto reliable streams.

Cold lowering checkpoint: the public x86 decoder now consumes only the accepted
optimized ELF segments. Pure register cuts produce ordinary Wasm importing only
machine.memory; decoding and source bytes are absent from execution. Lazy local
register loading and dirty-only writeback avoid full-state materialization per
instruction. Seventy-six post-linked fixture modules plus the first three
instructions of the shipped BusyBox entry pass 39,424 native-x86/Node-Wasm
comparisons (narrow parents, flags, LEA, immediates, all 16 Jcc conditions).
Overlapping output/borrowed-ELF buffers first reproduced mutation on rejection;
the emission admission now rejects that alias before writing. Bounds, RIP and
TF/RF rejection do not mutate linear memory. Per-bit final flag definitions
remove dead intermediate flag computation; the same composed optimized ELF
now emits 366 instead of 454 Wasm bytes. ADD -> INC preserves the earlier carry;
INC -> DEC and logical/narrow chains also match the native oracle. Planning,
measurement and emission use bounded linear passes with one borrowed map table,
not a decoded instruction vector or repeated module reconstruction.
These are bounded cut checks, not
whole-image coverage, Linux/browser boot, new distribution timing or publication.
Scalar-memory checkpoint: MOV/MOVZX/SX loads and MOV stores now produce a
one-instruction direct Wasm cut behind the typed C RAM boundary. The preceding
pure slice ends before the faulting instruction. State/port alias/bounds and
AC/TF/RF checks happen before access; failure does not retire or mutate CPU
state. Twenty-two post-linked memory modules pass 11,264 native/Node cases.
The old register-only compiler rejects the same input with -102; the existing
77 register modules/39,424 comparisons still pass after rebuilding. C resident
RAM passes 100,000 write/read round trips, cross-page preflight, high-address
aliases, cached-fault direction, stale generation and invalid reopen checks.
Missing translation/residency is a bounded address/range/right request, not
an invented page fault, zero-fill or decoder fallback. That provider requires
a serialized pinned owner and already admitted CPU/MMU context; it is not a
page-table walker or concurrent-worker atomicity proof. The Node access
function is a test double, not product execution. No native artifact/UI changed.
This earlier test-double checkpoint is superseded by the C-Wasm integration
below, not relabeled as an actual browser run.

Current checkpoint: all 22 memory and 11 64-bit stack/control modules now run
through the actual C vm.wasm/MMU function export, with 16,896 native-x86/Node
comparisons. PUSH/POP/direct near CALL/RET preserve cross-page preflight and
fault noncommit; POP RSP and the pushed CALL return coordinate are explicit
oracle cases. The four-level 4 KiB/2 MiB MMU passes 49,152 permission cases,
canonical/#SS/#GP, physical-miss, A/D and reserved-bit checks. That matrix is
not yet a QEMU/hardware exception-delivery differential or complete MMU.
The user supplied an actual ordinary-memory browser result: 512 cases,
generation 9, 3,920-byte provider, no JS guest-memory callback. Its exact
receipt is retained in vm/check/browser/evidence; later builds are distinct.
CLC/STC/CLD/STD also join the pure frontier; all 83 pure modules, including
the shipped BusyBox prefix, pass 42,496 native/Node comparisons. Undefined
flags remain excluded and CMC/interior flag consumers are still rejected.

The shipped kernel's generated feature masks reproduced a missing PAE/PGE
CPU contract (`00002040`); the independently versioned v2 CPU identity passes
that gate. The fixed distribution recipe is still v1, and published bundle
bytes/v1 receipts are unchanged. No exactly masked native boot is claimed.
The C boot loader now borrows the bzImage header and emits only initial
metadata pages or bounded kernel/initramfs source extents. Actual shipped
kernel/initramfs -> native/C-Wasm initial-state/page comparison -> C-MMU
fetch at 0x1000200 passes. This is initialization/fetch, NOT execution/boot.
100,000 header mutations check safe rejection/layout, not universal boot
compatibility. Initial zero pages never replace dirty/suspended machine state.

Ordered next blockers:
1. Complete executable-generation/load/CPU attestation and C cold-compiler/table
   admission. A uniform two-parameter table, C budget dispatcher and precise
   fetch-page cuts are now tested, not yet a complete admission transaction.
2. Actual startup sequence: indirect control (REP page supply is now tested),
   then required system/MSR/SIMD/exception operations. Shifts/POPF/REP MOVS, RMW,
   LGDT/LRET, common CR reads/writes and memory CMP/TEST are now tested.
   Decode remains cold compiler work, never a runtime instruction loop.
3. Admit the actual compressed-kernel code/decompression/relocation path;
   connect interrupts, UART and authenticated read-only root block supply.
4. Real-browser kernel/PID 1/offline terminal, then the existing development
   and browser storage/network acceptance gates. Whole-image -104 and
   actual Linux/browser boot remain red; fixtures/QEMU cannot substitute.

Dispatcher checkpoint: the old pure table type was red with a real Wasm
signature mismatch. Uniform entries pass 83 modules / 42,496 native cases
through C dispatch. A fetch-time revoke was independently red; any RAM write,
including page-table A/D, now revokes before the next call (code can alias
tables). The call-local mutation bit adds no wrapping write epoch; it does not
prove supervisor generations/ABA safety or substitute for source attestation.
The shared C cold compiler accepts borrowed executable pages without a fake
ELF or source interpreter. Actual shipped `CLD; CLI; XOR eax,eax` retire in a
single C quantum, then ENTRY_MAP identifies segment load `0x1000204`.
CLI's non-PVI long-mode IF/#GP matrix passes; hidden state, STI/shadow and
exception delivery remain red. These are Node/C results, not browser boot.
The v2 diagnostic Worker uses C table dispatch; its Node setup test does not
retcon the user's earlier actual-browser v1 receipt. Native asset/UI unchanged.

Segment checkpoint: register-source ES/SS/DS/FS/GS loads now use a typed C
descriptor transaction, not source interpretation. A versioned 136-byte hidden
cache/MOV SS context leaves the frozen register ABI and native bytes unchanged.
GDT/LDT, type/privilege/presence, Accessed update and noncommit checks pass 8,272
native C model cases; generated cuts pass another 8,272 Node/C-Wasm model cases.
MOV SS forces a one-instruction next cut and its shadow survives pending faults,
not a complete interrupt/debug delivery proof. Actual shipped startup retires
14 instructions, then stops at `0x1000232` memory ADD. Final full check and both
VM/compiler ASan/UBSan pass; regenerated native fixture comparisons stay green.
The standard browser-control kernel initialization still fails before JS.
See vm/check/browser/evidence/2026-10-02-segments.md; real Linux boot remains red.

Bundle construction checkpoint: `data/oracle/compile-native-bundle.sh` now
authenticates the exact published 63,219,311-byte archive and constructs kernel
and BusyBox prefixes directly, without a new bake/Kbuild input or full-root
expansion. Kernel: 11 modules / 14 instructions / 3,187 bytes, memory ADD still
red at `0x1000232`; BusyBox: two modules / five instructions / 639 bytes, direct
CALL emitted but its whole-image control closure not claimed. Prefix CLI exits
3 with `closed:false`, source/end/control/budget diagnostics and no-clobber/
rollback checks. Default whole-image emission is still red with -104.
The cold C compiler now runs in Wasm with only an ordinary-memory import and
no JS decoder/WASI/allocator: 130 modules match native C emission byte-for-byte.
The v3 diagnostic Worker compiles its cut in that C-Wasm compiler before C VM
dispatch; its 512 native comparisons pass in Node, not a real browser receipt.
Keep compiler and VM C static/stack memory disjoint. Browser-control still fails
before JS kernel initialization. Final all-product check, compiler ASan/UBSan,
byte-emission comparison and bundle C-Wasm startup check pass. Native/UI bytes
remain unchanged. See the
direct-bundle construction instructions in BROWSER.md. The ordered blockers
above still apply; this checkpoint does not make Linux/PID 1/browser boot green.

## Previous acceptance state — before compiler refactor, 2026-10-02

The full `febcab1c...` bake completed successfully. The exact local native
download is retained in [artifact/native](../../../artifact/native/README.md):
63,219,319 bytes, SHA-256
`2268542be55793e27e2a9ec7b9906a7296c7c3d3f266e198325b926e33af8fc2`.
All 199 ELF compilation calls, 45 signed installed packages, declared runtime
closure, C/make, upstream zlib development, crypto/key generation, archive
round-trips, and extracted-bundle certificate-verified Git/HTTPS passed.
The exact downloaded root also passed actual kernel/PID 1/services/offline
boot, C/make -j4/Git/AES/apk and COW tests in QEMU TCG (one ready observation:
1,879.9 ms; excludes download/extraction, not a browser guarantee).

Complete canonical filesystem storage is **517,221,624 -> 251,808,350 bytes**.
The fixed 11-workload native benchmark is nevertheless **red-speed**:
weighted mean ratio **1.002329099** with 401 alternating pairs per workload.
All workload observations matched. Preserve this red result; do not relabel
the local test-key candidate as a public release or claim native speedup.
Identity calibrations measured GCC 0.999699920 and Git 1.003331286; they do not
erase the real comparison. **The user accepts this small timing difference for
the current stage; native speed is not the active blocker.** Preserve the raw
benchmark and make no speedup claim. Prioritize corner cases, undefined
behavior and compiler source boundaries. The diagnostics below are historical; the final
ordered witness list is the active work queue.

## Current correctness/refactor checkpoint — 2026-10-02

- The former 24,291-line `select-x86.c` is removed, not included or wrapped.
  Its 395 existing functions are preserved in 21 independent selection
  translation units, with separately testable cost queries and orchestration.
  Private source/header names now state their job: `compile-elf`, `jump-table`,
  `discover-entry`, `instruction-semantics`, `form-block`, `normalize-ssa`,
  and `x86-selection`. No public product API or optimized-ELF format was replaced.
- TSan reproduced the shared generation write; grammar-invocation-owned bounded probe
  scratch removes the race without TLS, a lock, or a process-global epoch.
  Four independent same-address/different-image callers pass 1,024 concurrent
  selections against their serial emitted bytes and fixups. The small memo
  lives only during one grammar invocation, not in each saved proposal; its
  pointer is cleared before returning any candidate or diagnostic. Test
  threads explicitly use 2 MiB stacks; this is not a small-stack guarantee.
- UBSan reproduced an unaligned operand store from an unaligned byte-arena
  base. `support` now aligns the actual address; 352,600 alignment/capacity
  cases cover empty allocations, undersized ranges, NULL and integer limits.
  The public compiler separately enforces its measured 16-byte workspace
  contract before any typed access; all 15 misaligned offsets are rejected.
- A general red cost-query witness contained three identical Pareto points
  but only one output slot. Duplicate metric points now choose one stable
  input rank. The common serial cost cancels from comparisons; immutable
  candidate costs and a 76-byte rank vector replace per-comparison proposal
  copies. Twenty thousand candidate families match an independent oracle.
  Candidate/fixup count overflow is rejected before array indexing.
- Fresh archive publication and source-layout checks reject dead unlisted
  sources, obsolete members, and duplicate member names. Selection LEA code
  is named `lea.c`, not a second `affine.o`. Native GCC parity recurses into
  `selection/` instead of silently skipping the new units.
- Final full `make -C src/v2 -k -j2 check`, ASan/UBSan selected checks and TSan
  pass. These are compiler checks, not a new distribution bake or a native
  speed claim. The signed `3238ae02...` bundle retains its previous identity.

## Product gate (long-term publication contract)

Build the fixed `development-standard-v1` distribution from verified upstream
sources. Post-link compile every linked `ET_EXEC`/`ET_DYN` and the kernel into
ordinary, independently executable optimized x86; prove equivalence before
packaging. Publish only if the complete immutable release is smaller and paired
native execution is faster than the same linked-input population. Then project
the same accepted program and Linux authority through Wasm for the browser.
An interpreter, missing-block fallback, or separate browser POSIX semantics
does not satisfy this gate. The normative contracts are
[CONTRACT.md](CONTRACT.md), [BENCHMARK.md](BENCHMARK.md), and
[DISTRIBUTION.md](../docs/DISTRIBUTION.md).

## 2026-10-01 resumed checkpoint and next blocker

- The former real `readelf -rW` segfault is fixed through closed table-set
  verification. Discovery may stop at a provisional unknown table, but strict
  fixed-point verification never treats that unknown as a terminal. Guard
  failures are checked in both branch orientations, including forward paths.
  The positive closed-loop fixture crosses 1,200 instructions; the negative
  guard-bypass fixture removes dependent tables on subsequent strict passes.
- A separate actual miscompile was reproduced: a `JBE` whose arms merge was
  incorrectly taken as a 9-row bound although row 50 is used. The source
  exited 42; the statically verified output exited 1. Merged edges now retain
  both arms' union, and the constant definition proves 51 rows. Split-arm,
  long-function, and 301-row variants also execute with the source result.
- Large-function CFG proof silently fell back to failure because its measured
  arena omitted the CFG scratch. Measurement now includes the maximum sized
  function's transient requirement, reused between functions and proof passes;
  no CFG buffer is serialized. This is still a per-byte analysis coefficient,
  not a claim of minimal compiler memory. Removing the 256-row speculation cap
  recovers the 259-row table at `0xf5494`. Real readelf has 264 proved bases,
  including `0xf5a90`, `0xf5ab0`, and `0xf65a0`.
- The resumed complete bake then rejected Binutils `as` at `0xc8e34`: `E9`
  inside the LEA displacement at `0xc8e30` was promoted from an unrelated
  data relocation's `S+A` to a five-byte trampoline. Its fabricated jump
  target was `0xffffffff89548e45`. A data word cannot authorize a non-image
  execution entry; this promotion is now rejected, with a synthetic interior
  displacement regression. As compiles to an ordinary ELF and passes proof.
- All `make -C src/v2 -j2 check` checks passed after those compiler fixes.
  Real preflight now pairs relocation output, binary extraction, and assembler
  object bytes. It passes: readelf 3,330,808 -> 1,100,616 bytes; objcopy
  3,680,432 -> 1,597,464; as 4,889,672 -> 2,238,296. These are component
  sizes and execution comparisons, not a complete release or speed result.
- The boot wrapper reused stale compressed-image lengths in `zoffset.h` and
  the setup header. It now rebuilds offsets, header, setup ELF and setup binary
  with the matching saved Kbuild commands, decoding Make's escaped record
  characters once. Its positive and failure/restore checks pass. An isolated
  initramfs now uses the current recipe's BusyBox, rather than the first old
  cache match; UART commands wait for the shell prompt and are paced.
  The linked baseline passes kernel -> init -> shell/exec/arithmetic in the
  pinned QEMU TCG oracle (1,197.5 ms to the probe-ready marker). This is not a
  whole-root cold-shell measurement or a native/browser performance claim.
- The first actual optimized-kernel failure was a local LEA continuation
  dropped across the precise PUSH cut. LRET used the old, removed address
  `0x1ae8206`, eventually faulting at `0x1b14016`. A general near-RET fixture
  reproduced source exit 42 versus optimized segfault despite static proof.
  Frontier consumer discovery now preserves the exact register generation's
  code address across the next memory/control consumer, without a per-address
  CFG scan. Near RET, far RET and copied-register variants pass.
- The next failure was Linux's static-call opcode validation: relative
  metadata retained old interior CALL addresses, and a section-symbol addend
  did not obtain its own source-identity instruction extent. A runtime-selected
  relative CALL-site fixture was red and now passes. Referenced five-byte
  direct CALL/JMP sites with in-image targets receive an exact instruction
  grid, including interior section-symbol coordinates; candidate measurement
  reserves these transient grids. The real kernel advances past that check
  into initial console, memory and IRQ initialization. All `make -C src/v2
  -j2 check` checks pass after both fixes.
- The first low-address fault at `0x300` was another proved format with wrong
  emitted semantics. In `mas_update_gap.part.0`, the SSA correctly retained
  `insert64(RDX, 0, 8)`, but the dense ALU candidate emitted only `xor cl,cl`,
  dropping `mov rdx,rcx` and its upper-bit ownership. A tiny pointer fixture
  reproduced the segfault. Narrow flag-result publication now copies the full
  base before operating on its lane; an overwritten right entry operand or an
  unproved base shape cannot claim that production. Byte/word, AND-zero and
  extended-register execution variants pass, including the defined ZF and a
  full 64-bit word result; selection checks reject the former 1-work/1-span
  claim. All `make -C src/v2 -j2 check` checks pass after this fix.
- The `0x450` console failure came from an unadmitted local `con_init`
  callback, not the console's pointer arithmetic. Linux's initcall rows use
  their own coordinate as the PC32 base; projecting an undiscovered function
  into a neighbouring body produced an incorrect callback. Referenced actual
  linked PC32 values now admit exact static function starts via a transient
  bitmap, including section-symbol addends. A symbol alone still admits
  nothing. The general relative-function-table execution fixture and full
  checks pass. The resulting ELF grows to 14,617,792 bytes from 19,967,480;
  12,520,640 was not a valid smaller executable. Real boot passes console/PIC
  setup and enters the delay loop.
- The delay loop's first zero-address instruction fetch came from a lost
  BSF pass-through in `handle_softirqs`: its `mov ebp,-1; bsf r12d,ebp;
  add ebp,1` became BSF/ADD only. Zero input then reused the old loop index
  and called a null callback. BSF/BSR now carry the complete previous
  destination generation into SSA and seed it before native emission.
  Six width/direction execution fixtures and 1,478,656 shared-expression
  comparisons pass. Zero-input results are compared against the actual CPU,
  rather than asserting universal 32-bit upper-half behaviour. Two old
  selection expectations had incorrectly rewarded deleting that input and
  were corrected. Full checks pass. Real boot now completes delay calibration
  and enters CPU/FPU initialization.
- Two further first-divergence witnesses there are now red-to-green: CPUID's
  EAX leaf seed was projected away, and a nested low-word constant insert
  emitted a full 32-bit MOV. Machine inputs now come from all decoded explicit
  and hidden operands, including conditional reads, address bases/indices,
  flags and FS/GS dependencies, rather than a handwritten opcode-family mask.
  A decoded CMPXCHG16B witness exposed 0x80 versus required 0x8f inputs;
  CPUID, MSR, control-register, vector, string and atomic input cases pass.
  The shared rule retains CPUID's EAX/ECX in future liveness and dependencies;
  constant seeds at byte/word width preserve the base's other bits.
  `cpuid-inputs-check`, `partial-clear-after-flags-check` and full checks pass.
  Raw native-layout offsets and unchanged compressed kallsyms are not
  reliable source names for emitted instructions. Static proof alone still
  does not certify this kernel or authorize release publication.
- The next real boot entered VFS initialization, then executed overwritten
  DIV bytes. An external hardware watchpoint caught a runtime-constant patch
  writing 0x7ffffffff000 into that unrelated instruction: its rel32 metadata
  had lost the MOV-immediate field's exact owner. Address-valued instruction
  bytes now close after execution roots, retain the discovered owner's exact
  source spelling, and never become entries at the literal byte. A fixture
  patches two distinct 8-byte immediates and a 1-byte shift count and executes
  all three; it changed from source exit 42 / verified-output exit 1 to green.
- x86 exception-table rows close their exact fault instruction and external
  fixup target using the linked 12-byte ABI, not stale construction addends.
  Warning records close their code site and, for UD2, its external resume
  coordinate. Code relocation fields identify warning sites without assuming
  a diagnostic-record stride or treating argument setup as a trap. Separate
  exception and warning fixtures changed from verified-output SIGSEGV to 42.
- The resulting optimized kernel passes the independent QEMU TCG probe:
  kernel -> init -> shell -> exec -> arithmetic. Its ELF is 14,617,792 bytes
  from 19,967,480 (26.79% smaller); 1,248.7 ms to the probe-ready marker is
  not a whole-root cold-shell result or evidence that native execution sped up.
- Full-recipe preflight then caught an overly broad immediate-byte admission.
  A referenced mixed `.rodata` section does not establish field-relative
  addresses for all its rel32 words. A jump-table row projected into a LEA
  displacement (0x19da4), and then into a genuine but unowned shift immediate
  (0x23f1c). Admission now requires a complete dense rel32 code-address
  directory and a linear declared-function immediate-shape index; actual
  native discovery still must prove the owner. Neither index is serialized,
  and no per-field function scan is introduced. Unowned-displacement and
  mixed-data regressions, full checks, and real readelf/objcopy/as parity pass.
  The full bake's new kernel reprojection has the same SHA-256 as the first
  passing ELF (b645f3f95ad72b41a48d477d720fe4b81ca2d9aba5c0f265a23c29a3238d24f9)
  and independently passes the shell probe again (1,174.6 ms probe-ready).
- The resumed release-wide stage reached GCC's cpp and rejected a false
  five-byte CALL grid at 0x40540c: that E8 is actually inside the six-byte
  address-size-prefixed CALL starting at 0x40540b. New closure diagnostics
  report the exact missing grid boundary instead of stage/address zero.
  The declared-function instruction index now filters both patchable control
  sites and bounded reverse immediate-owner searches. A prefixed-CALL fixture
  changed from source exit 42 / closure rejection to green. Actual cpp
  compiles/proves at 5,755,688 -> 2,511,960 bytes and produces identical
  preprocessed output with the same pinned cc1. Full checks pass again.
  Toolchain preflight now includes cpp before the expensive release stage.
- The complete bake after that cpp correction passed the former `as` and cpp
  blockers and reached GCC in the same 199-ELF population. It was then stopped
  before publication to fix the real cc1 execution failure below;
  `temp/full-bake-prefixed-directory.log` preserves the failed checkpoint.
  The exact kernel
  checkpoint retains the passing optimized ELF digest above; its rebuilt
  bzImage also independently passes kernel -> init -> shell/exec/arithmetic
  (1,211.4 ms probe-ready, still not a complete distribution or speed result).
  It has **not** yet passed the full root, extracted download, development,
  Git/HTTPS, boot, or paired performance gates with this compiler. Older
  candidate bundles exist; none is evidence for this current checkpoint.
- During that run, an isolated negative layout check caught a diagnostic-only
  crash: reopening native workspace deliberately has no population owner, but
  invalid code-grid error paths dereferenced it. Zero-stride and non-boundary
  grids reproduced SIGSEGV (139); the guarded diagnostic helper now returns
  `PL_ERROR_BLOCK` for both. The full native-layout witness passes with the
  replacement object and is included in the subsequent full checks.
- Real optimized GCC failed even on a header-free C function: cc1's shared-base
  relative switch tables had no admitted bound. The rejected arm tail-called
  a longer function, but the guard checker stopped after eight instructions
  outside the caller's symbol extent. Generic field-relative relocation then
  produced an instruction-interior jump. A standalone assembly fixture changed
  from source exit 42 / verified-output SIGSEGV (139) to exit 42.
  The finite control queue now follows all direct arms across symbol boundaries
  to actual terminals or the same guard. Exhaustion still rejects the proof;
  direct and conditional routes bypassing the guard both reject the table.
  Full `make -C src/v2 -j2 check` checks pass, and both negative variants pass.
- The real corrected cc1 is 38,742,584 bytes from 80,559,464. Its static proof
  passes; the optimized GCC driver and a larger physical-SSA C translation
  unit emit byte-identical assembly to the pinned linked GCC. These are real
  code-generation parity results, not a release-size or speed claim.
  Those two C witnesses passed, but the broader compiler-source comparison
  below found another failure. `temp/full-bake-tail-call-table.log` preserves
  the deliberately stopped bake; it is not a published release.
  The fixed recipe must still pass full-root, extracted-bundle, development, Git/HTTPS,
  complete boot and paired performance gates before publication.
- The broader comparison failed on block.c in GCC's tree_truth_valued_p:
  TEST AL,AL was erased before an absolute-table indirect jump, although
  its targets begin with JE. With dumping disabled, the wrong flags entered
  a debug-output branch using a null FILE. Construction-value retention had
  replaced the independent external-edge observation instead of joining it.
  Those demands now compose by union. A general computed-jump fixture changed
  from source exit 42 / verified-output exit 1 to 42; full checks pass.
  Release parity now compares every compiler C translation unit, not only
  startup, the tiny function and physical.c. Regenerated cc1 no longer crashes
  on block.c; the wider comparison then found the scheduling failure below.
- Real GCC's inline decision for relocate-elf.c differed even with a fixed
  random seed. At a load-preserving flag boundary, SETne R9B was scheduled
  after a preloaded SHR R8D, rather than before it. That changed the inline
  hint while the output still passed static proof. A general assembly fixture
  reproduced source exit 42 / verified-output exit 1. Entry-flag readers now
  precede every pending flag-clobbering publication, and the common preload
  shape rejects clobbering trees until those readers are published. Four
  width/condition/multiple-reader fixtures pass. Regenerated real cc1 emits
  byte-identical assembly for all 28 compiler/benchmark C translation units.
  Its 38,742,584-byte ELF is still a component, not the release-size result.
- The new execution property check also exposed unconditional byte narrowing
  of a 64-bit OR: the value matched, but SF/ZF (and high-byte PF) did not.
  Architectural ALU emission now preserves its flag width; only value-only
  productions with subsequently overwritten flags may use a byte overlay.
  All 16 SETcc conditions, 32/64-bit SHL/SHR/SAR and AND/OR/XOR pass
  7,077,888 source/generated/reference comparisons without source fallback,
  including accumulator/extended destinations and low/high-byte/upper masks.
  The dead-flag split overlay is one byte smaller by using OR AL,imm8;
  the existing exact-byte expectation now records that valid shorter schedule.
  Full `make -C src/v2 -j2 check` passes, including the earlier 39,845,888
  comparison-cut and 1,478,656 shared-expression comparisons. Unsupported
  host bit operations remain explicitly reported as skipped, not passed.
  `temp/full-bake-entry-flags-preload.log` is the resumed full-recipe bake;
  complete population parity, bundle/development/HTTPS, boot and paired native
  performance still gate publication. Signing here uses a test key only.
- The current corrected kernel checkpoint is
  `postlinked-kernel-ab8a56ec252d9f1fa2d68ff9cb693f4f233708242f96bf46fc302e40c19fc975`.
  Its ordinary ELF is 14,617,792 bytes from 19,967,480; the matching bzImage
  boots the pinned QEMU TCG CPU through kernel -> init -> BusyBox shell,
  executing `uname` and shell arithmetic/exec. The isolated probe-ready marker
  was reached at 1,152.4 ms (`temp/native-boot-probe/entry-flags-serial.log`).
  This is not the complete root's offline interactive-ready/service milestone,
  not a cold-browser measurement, and not evidence of native paired speedup.
- The partial `/usr`/certificate bind and shell-only init are removed. The
  archive mounts the complete installed SquashFS lower, a bounded tmpfs COW
  upper, moves API/backing mounts and switch-roots into installed s6-svscan
  PID 1. Console activation requires the compiled offline service transition;
  mount/root/readiness oneshots check actual state instead of `/bin/true`.
  The same fixed kernel config enables OverlayFS and tmpfs xattrs; BusyBox
  enables move/switch_root and controlling-terminal helpers. Full-root QEMU
  acceptance remains mandatory: it checks PID 1, active offline services,
  C/make -j4/Git/apk, lower immutability and absence of upper `/usr` copies.
  This gate rejects an isolated shell and any diagnostic edited upper root.
- A signed/installed 45-package linked-userland reference exposed two boot
  recipe defects on the linked kernel too: mount options after source operands
  fail with the minimal BusyBox parser, and daemon `run` files without a
  shebang fail direct exec in s6-supervise. The source fixes reorder the
  options and add exec-style shell scripts. `check-service-sources.sh` rejects
  the old definitions and accepts the three fixed longruns before compiling
  the database. A third defect forked an interactive shell out of s6's console
  service: s6-supervise already creates its session, so BusyBox setsid forked
  and exited, causing repeated shell respawns and competing UART readers.
  The service now uses cttyhack directly in that existing session. The fixed,
  independently signed/installed 45-package linked-userland root passes real
  PID 1, offline services, C compile/run, make -j4, Git/apk and lower/COW
  checks on the linked kernel (2,200.9 ms TCG service-ready). This reference
  is not a post-linked whole-population release or a performance benchmark.
- The former release key
  `f6c00d7ec8c5308ace363ba674d49de94f1602ef93af4de4fdd9a61a042742b6`
  finished all 199 ELFs, then was OOM-killed in executable-fragment projection
  at 7,781,188 KiB peak RSS on the 8 GiB build guest. It published no candidate.
  Program observations are now generated borrowed spans rather than 48 bytes
  per state (1,077,413,232 bytes at that 22,446,109-state population). Fragment
  capacity counts only nonempty intervals; descriptor ownership transfers to
  the sole payload view and exact reconstruction compares spans without an
  opened ELF buffer. State columns are sealed and insertion indices freed;
  fragment and future scratch no longer overlap. Full `make -C src/v2 -j2
  check` passes, including a 65,536-state sparse-fragment fixture and exact
  generated-view/array-sharing parity. These are build-memory improvements,
  not retained release-byte or native-speed results.
- The next bounded-memory bake, release key
  `db35c90079ff799bc10a0918d4bebcd5c189cac51af45df28e99c4a419d1d29c`,
  CLI SHA-256 `ab6b6478e07b0b0bfcc6f1ab3a950e59576acfa0a687d307017347852b02d541`,
  stage SHA-256 `b82d364cc52ab37254a4bbbe61badd6f22d518fab3e498a4312d5066ea6ac6d8`.
  finished all 199 ELFs (479,197,872 -> 199,243,392 component ELF bytes;
  22,446,454 states). It passed the former fatal fragment stage at 4,042,608
  KiB peak RSS, payload quotient at 4,081,788 KiB, and canonical program/future
  at 6,176,324 KiB, then was OOM-killed allocating rank-map working pools
  (7,870,876 KiB anonymous RSS). It published no complete certificate or
  candidate. The future, block-rank and payload-rank working pools now borrow
  one max-sized phase arena; durable rank trees still own distinct storage,
  and both complete proofs run before that arena is reused. Full checks pass.
  The corrected full-population memory gate still requires a fresh bake;
  component ELF totals are not complete release bytes or native speed.
- The complete optimized-kernel boot exposed corrupted SquashFS reads, despite
  the isolated initramfs probe and static proof being green. The full root's
  BusyBox first differed at byte 6,697. A tiny compressed image fails on the
  optimized kernel while the same uncompressed image reads exactly on both
  kernels. Linking the actual Kbuild Zstd objects into an ordinary userspace
  ELF reproduces source exit 0 / verified-output SIGSEGV on inode metadata.
  At HUF_readDTableX1's tail, MOVSXD + ADD + CMP + JLE became CMP + MOVSXD +
  ADD + JLE. The preserving extension leaf did not make its parent ADD a LEA.
  ADD overwrote the branch flags and entered a tail past the valid extent.
  Scheduling now admits flag-preserving additions only when the actual
  coordinate leaves have an encodable LEA spelling. The tiny ordinary-ELF
  witness changed from source 42 / optimized 1 to green in four conditions;
  1,310,720 additional source/all-candidates/reference comparisons cover five
  signed/unsigned extensions, every Jcc and complete defined CMP flags.
  No kernel name/address exception or runtime fallback was added.
- The unchanged 20,077,600-byte recipe vmlinux.unstripped now produces a
  14,622,864-byte verified optimized kernel. Its rebuilt bzImage passes the
  same full signed/installed linked-userland root through PID 1/services,
  C/make -j4/Git/apk and COW. An idle TCG repeat reaches interactive-ready
  at 2,057.8 ms; the earlier run overlapped compiler checks and took 5,427.2
  ms. Neither sample certifies native speed or a fully post-linked release.
  `make -C src/v2 -j2 check` and the actual Kbuild-object Zstd metadata/paged
  stream byte-parity oracle pass. Current CLI/stage SHA-256 are respectively
  `f5cfa9567e6850c545866db27953c3a3c9bde16ca6da2886a6f377c466e693f1`
  and `a52eb9a79ccea5d028ea856e0a004718bc40abbbfc4482d1b37fd70927789826`.
  The next fixed-population bake must use these tools and the corrected boot
  sources, not reinterpret an earlier failed release key as complete.
- The same optimized kernel also passes the full installed-root gate with
  the current verified optimized BusyBox (2,740,880 -> 407,864 bytes),
  including its initramfs and installed hardlink applets. The 45 packages
  were independently signed and installed again. PID 1, offline service
  state, C compile/run, make -j4, Git/apk and immutable-lower/COW checks pass
  at 2,159.4 ms TCG interactive-ready
  (`temp/native-boot-probe/compare-address-userland-full.log`). The other
  userland ELFs remain linked reference inputs; this composition check is
  neither a whole optimized release nor a paired speed measurement.
  The fresh whole-population bake is now running with the above exact
  compiler/stage and current service/device configuration
  (`temp/full-bake-address-flags-arena.log`), release key
  `5af05437a7cc7e903cb17043bc3188c44459659dd2a9613be7c96b53e87abb09`.
  It must independently pass
  the former final rank-map memory failure and all publication/runtime gates.
  The actual Kbuild-object oracle also passes malformed/truncated stream
  error-return, diagnostic and written-prefix parity. A crash is not accepted
  as an equivalent error (`temp/check-kernel-zstd-error-parity.log`).
- The fresh `5af05437...` bake has now passed the complete 199-ELF stage,
  including the former rank-map OOM point and factor selection. Peak RSS is
  **7,108,232 KiB** on the same 8 GiB guest; complete-sharing takes 96.57 CPU
  seconds and factor selection 169.44. The complete gate remains enabled:
  22,446,454 states, 44,892,908 successor coordinates, all six semantic
  families, 31 archives and 4,253 external payloads. There are still 360
  nonjoint optimization witnesses; executable closure is not a proof that
  every selected cell simultaneously reaches both independent cost floors.
  The pre-package population has 165,116,056 canonical bytes and a
  74,569,455-byte exact factor spelling (zero factor gap). This excludes the
  subsequently generated boot package and installed package/trust metadata;
  it is **not** the complete distribution's accepted 75 MB result, download
  size, or native-speed result. Package parity and actual product runtime
  gates are the next checks. The exact linked population is retained under
  `temp/native-benchmark-linked-5af05437` for the paired comparison. The
  diagnostic unaccepted output namespace has been removed after the complete
  gate committed; it was never an alternative release checkpoint.
- The first real signed/installed candidate correctly failed the standard
  profile gate: an old, reused Git component root still carried `git-daemon`,
  `git-imap-send` and `git-http-backend`. The profile already excluded them;
  accepting a component checkpoint did not enforce current package selection.
  `prepare-package-payload.sh` now applies that policy in the sole pre-signature
  publication path, using a transient hard-linked namespace without changing
  any compiled ELF or the component owner. Apk signatures and ownership DB
  therefore refer to the same final bytes, not a root edited after install.
  Old-checkpoint, idempotence, owner-sharing and destination-safety fixtures
  pass. The publisher and its policy projection are bound into the publication
  identity independently of the expensive post-link checkpoint. Re-publication
  initially resumed `5af05437...` without recompilation. That checkpoint is
  now invalidated by the semantic failures below, so the next publication
  requires the entire population to be compiled with the corrected tools. The rejected
  derived roots were removed; source/optimized component checkpoints and logs
  remain reproducible. The 74.57 MB factor result above remains a pre-package
  superset diagnostic, not the post-policy complete distribution result.

## Current native semantic gate — prior release rejected

- The complete `3bc6150c.../apk-1f38baab...` bake finished all 199 ELF
  compilations, proofs and real compiler/population parity; 197 unique ELF
  payloads shrink from 477,766,768 to 199,072,704 bytes. Its signed package
  closure and installed root checks pass, but it is also **not a release**:
  the stronger runtime check crashes during Ed25519 `ssh-keygen`. The final
  bundle remains unpublished.
- The option dispatch at source `0x8f6be` consumes 58 rows at `0x4bb250`.
  Backwards byte decoding had invented a CMP inside the previous CALL's
  displacement, enlarging the alleged bound to 972,587,777 rows. The table
  was then omitted; its literal old target entered a relocated JMP interior.
  Bound collection now walks actual source instruction boundaries once and
  retains only nearby real comparisons. Immediate, displacement and ALU
  variants of `interior-compare-table.S` reproduce the missed table before
  the fix and execute with source exit 42 after it. No instruction/function
  address exception is used in production.
- The real linked ssh-keygen is 12,565,416 bytes; its corrected ordinary ELF
  is 6,300,120 bytes and successfully generates an Ed25519 key. The complete
  `make -C src/v2 -k -j2 check` passes (`temp/check-boundary-compare.log`).
  The real key generation/readback witness is now part of toolchain preflight
  and the installed-root gate. Both the linked reference root and corrected
  keygen pass. Recompile the complete population with these corrected tools;
  do not ship the preceding root or reuse its optimized outputs.
- The subsequent complete bake was `temp/full-bake-boundary-compare.log`, key
  `53120f85c1b6d00497ff3a1ba74f310d57772831495269dc61e3329c6f4b122a`.
  CLI SHA-256 is
  `876796467720973fd7f0414e682df724eb1a07bd5e294f5af4b7ca845b2ab42d`;
  release stage SHA-256 is
  `73f7240c4c28134204c66a0b79ffa0493a615aff43342a8400fdc5d873d346b0`.
  Per-ELF profiling reached 198/199 before that stage was deliberately stopped:
  a diagnostic benchmark of the preceding rejected root found an actual
  `xz -c` crash. The same crash remained under the boundary-compare fix.
- Xz's range coder compares `[rdi + 4*rax + 48]`, then loads its bounded index
  from `[rdi + 4*rcx]` with `rcx = rax + 12`. Treating those as distinct
  addresses omitted the five-row shared-base table and retained its old code
  targets; the first faulty jump entered another function's loop. Exact
  64-bit effective-address substitution now recovers the equality. The defining
  LEA must dominate CMP, and changed pointer/index generations, intervening
  writes or a bypassed definition reject the rule. Nearby actual instructions
  are carried in the existing fixed-size comparison window; there is no new
  reverse-byte speculation or per-comparison function rescan.
- The positive native affine-address fixture executes with source exit 42;
  four mutation/bypass variants reject the bound. The actual corrected xz is
  302,024 bytes from 1,385,552 and emits the exact linked program's stream.
  Full checks pass (`temp/check-affine-memory-table.log`). Serial/threaded
  xz compression and readback now join real toolchain preflight and installed
  runtime acceptance. Recompile the whole population with this library before
  complete boot, exact-download checks and the final unloaded paired benchmark.
- That fresh population completed in `temp/full-bake-affine-memory-table.log`,
  key `febcab1c562ed4ef394ec2bee0b6fa6c1223ab27e1e4ae87037b1d3fc297ef18`.
  Compiler/stage SHA-256 are respectively
  `814fd1faecef7803dfbd61cb268b8cc2a5997c6d35c6f7392f6a64e33db8593e` and
  `77fd59202e4e9a23008d3f20effae8bf0777b8405a87c30181dc0fdb59abd6f2`.
  Its optimized kernel/bzImage are byte-identical to the previous accepted
  kernel control; final whole-root boot still has to use the fresh delivered
  userland and initramfs, not the linked control image.
- The previous benchmark reference accidentally reused Kbuild's mutable
  `bzImage` after optimized wrapping. A fresh full linked reference now rebuilds
  boot from the actual 20,077,600-byte `vmlinux.unstripped` and original BusyBox,
  applies the identical package policy/profile, and passes native runtime.
  Its complete filesystem spelling is 517,221,624 bytes; the former
  516,001,017-byte shared-kernel diagnostic is not the final source baseline.
  Current reference: `temp/native-benchmark-baseline-full-linked-febcab1c/installed/root`.
  Linked kernel SHA-256 is
  `6a00b5e1f7a43ec45fa3f243919be9b1c14a505ea86427298ac5f9cefa6e7f28`;
  reference bzImage SHA-256 is
  `69eeda051e690c28840add3b135f8a914dcd90da47386d067da7600763aaff82`.
  The obsolete generated shared-kernel install/repository was removed (650 MiB);
  original inputs, source forest, build procedure and copied reports remain.
- The fully optimized root `5af05437.../apk-9e18a8b...` is not a release.
  Real complete-root boot reached PID 1 but its installed `s6-rc` crashed;
  certificate-verified HTTPS also crashed in installed curl. The staged
  downloadable bundle was not published. Static proof and the 74.57 MB
  pre-package diagnostic above do not override either failure.
- The s6-rc failure is a general entry-generation error in aligned stack
  allocation: a saved entry RSP was published from the updated RSP. Closing
  output dependencies now reject a transient schedule that has overwritten
  any required old-generation register. Three ordinary native assembly
  variants reproduce the failure before the fix and execute correctly after
  it. The corrected real s6-rc reads the original compiled service database
  and lists the six offline-ready services with exit 0. This is CLI/DB parity,
  not an optimized-root boot result.
- The next HTTPS fault came from an unrecognized switch in `SSL_CTX_ctrl`.
  Its default arm tail-calls an unknown method; the strict domain proof
  correctly refuses to treat that edge as a terminal. But losing the decoded
  table-base encoding incorrectly rewrote target-minus-base as
  target-minus-row, eventually entering unrelated code. A small ordinary ELF
  passed static proof yet looped forever after compilation (source exit 42).
  The same native witness is now green, including an allocated row changed
  after linking while its RELA record remains stale.
- One descriptor now keeps the independently decoded row encoding and its
  separate `domain_closed` fact. Encoding-only prefixes are retained only
  after the strict closed-set fixed point; they cannot discharge a bound or
  invent a finite indirect edge. All rows use the same relocation writer and
  final allocated bytes, not saved symbolic values. An unowned/unprojectable
  datum stays literal rather than acquiring a fabricated moved-symbol addend.
  Existing unconditional/conditional guard-bypass counterexamples remain red
  as domain proofs; no per-OpenSSL function exception was introduced.
- Corrected curl is **7,787,704 bytes** from the same **15,378,712-byte** linked
  input; it is 4,096 bytes larger than the invalid prior output. It performs
  the real local certificate-verified HTTPS GET successfully. This comparison
  runs inside the linked reference root; the subsequent Git clone and C build
  there are baseline controls, not evidence that the complete optimized Git
  or new installed release has passed. Log:
  `temp/native-semantic-recheck/curl-shared-base-https.log`.
- `make -C src/v2 -k -j2 check` passes, including stale-row/native switch
  execution and all old guard counterexamples
  (`temp/check-shared-base-encoding-final.log`). The installed-root runtime
  gate now reads the real s6-rc DB and validates offline service closure first.
  It passes the linked baseline and rejects the immutable old signed root;
  both roots remain unmodified. No paired real performance result exists.
- The preceding complete bake ran in
  `temp/full-bake-shared-base-encoding.log`, with new key
  `3bc6150cc53347f4894cef77bcad51983c41b13cb667ae1fc9c0db987dfc33ae`.
  CLI SHA-256 is
  `722fe9718fbcbb130fbde6bc1704450fc350896c78c33561d550a3b64adec4ca`;
  release stage SHA-256 is
  `7b37c7e61bb5e950f2b4f74c2f9ab7e3d9227ee84ae3618deda21a5ebd7108c6`.
  Both link the corrected library. The same linked kernel input compiles and
  verifies at 20,077,600 -> 14,622,864 bytes. The full 199-ELF population
  completed, but its runtime gate rejected keygen as recorded above. Reuse the pinned
  upstream/component inputs, never the rejected optimized population. Before
  this bake, two obsolete expanded boot-test installs were removed; their
  package inputs, compressed boot images, logs and current paired baseline
  remain reproducible. Guest scratch space increased from about 1.4 to 2.8 GiB.
- The corrected kernel has now also booted the linked-userland control in the
  external QEMU TCG oracle: actual PID 1/service state, offline readiness,
  `cc`, `make -j4`, Git history and apk queries pass. Log:
  `temp/native-boot-probe/shared-base-kernel-linked-system.log`.
  The 5,421.2 ms readiness sample was taken during the concurrent complete
  bake; it is neither a three-second result nor an optimized-userland release
  gate. Repeat on the final accepted installed root without compiler load.
  Native runtime acceptance now also requires RSA sign/verify (including a
  rejected altered message) and an AES/PBKDF2 encrypt/decrypt round trip.
  These checks pass in the complete linked reference root
  (`temp/native-semantic-recheck/source-runtime-crypto.log`); they retain no
  key or test payload in the release.

## Earlier component checkpoints (not release acceptance)

- The Windows-hosted build guest now uses a 32 GiB sparse virtual disk; the
  guest filesystem had roughly 2.8 GiB free before this fresh bake, after
  removing the reconstructible QEMU build expansion and an obsolete extracted
  HTTPS-test root. The upstream archive, Windows QEMU oracle, linked inputs
  and verified component checkpoints remain. No NixOS build path is used.
- BusyBox 1.36.1 exposed two distinct Pareto cases. At `0x1b242`, shared
  aligned-stack subtraction now emits an exact 20-byte, 6-work/4-span x86
  candidate, attaining both independent minima. At `0x3440b`, the available
  exact candidates are 9-work/2-span and 8-work/3-span: claiming the
  unattained 8-work/2-span pair would be false. The compiler now selects a
  nondominated exact x86 candidate, records actual costs separately from the
  independent lower bounds in X86N5, and marks the ordinary ELF proof as
  nonjoint instead of reporting a missing executable coordinate. The real
  BusyBox post-link output is 317,752 bytes from a 2,421,840-byte linked
  input; `postlink-verify` and `--list` pass. It still has 308 exact-source
  normalization escapes, which are optimization misses to inventory, not
  runtime fallbacks. This is not a full distribution result.
- The release executable stage formerly required zero normalization escapes
  and zero nonjoint Pareto cells even when every output coordinate had an
  exact x86 representative. It now admits and counts those explicitly, while
  preserving proof, complete-future, signed-payload and no-reentry checks.

- `origin/main` was fetched at `eca2d93` (merged PR #13) before this upstream
  update. The product source lock now selects Linux 7.2.7, BusyBox 1.36.1
  (the last series explicitly labelled stable upstream), util-linux 2.42.3,
  iproute2 7.2.0, dhcpcd 10.5.2, apk-tools 3.0.8, OpenSSL 3.5.8 LTS,
  curl 8.22.0, chrony 4.9,
  libnftnl 1.3.2, nftables 1.1.7, XZ 5.8.4, and IANA timezone 2026d.
  Source archives were downloaded and checked against the pinned digests;
  upstream checksum manifests were compared where published.
- The mdevd page advertises 0.1.8.3, but its linked official archive and
  checksum currently return HTTP 404, and the upstream mirror's newest tag is
  0.1.8.2. Keep the verified 0.1.8.2 source until 0.1.8.3 is actually
  obtainable and hash-pinnable; do not invent release bytes.
- The independent Windows-hosted QEMU build guest matches the bootstrap
  population lock. Linux 7.2.7 built `vmlinux.unstripped` and `bzImage`
  from its versioned exact config. BusyBox 1.36.1 built its static
  `busybox_unstripped` from its versioned exact config. These component
  results are **not** a distribution boot or publication result.
- `data/bootstrap/build-native.sh` built the native C products, and the full
  `make -C src/v2 -k -j2 check` passes in the guest, including the compare-cut
  differential check. The source snapshot now includes `src/v2/web`, and the
  check requires that directory before scanning it: the previous `! grep`
  silently treated a missing directory as green. This is **not** a complete
  release, size, or speed gate.
- The current compiler scanned the new `vmlinux.unstripped` and selected all
  793,247 blocks. It reports **326** normalization escapes (Pareto unresolved:
  0), but those blocks have exact source-x86 bodies and are no longer a
  compilation failure. The first optimization miss is
  `0xffffffff81206a37..0xffffffff81206a58`: an entry-flag test, conditional
  register moves, another test, and register publications before `_printk`.
  It emits work 8 against the recorded SSA count 7 (stage 244). This is a
  specific selection/quality diagnostic, not an unrecorded x86 instruction. The SSA
  count is **not** an x86 lower bound: for example, `movabs rax,2^32; lea
  r13,[rsi+rax]` has one addition node but requires two x86 instructions
  because the constant cannot be a signed disp32. Distinguish mandatory
  architectural publication from a real work/span miss before changing the
  quality target; do not clear it merely by labelling copied source normalized.
- The real Linux 7.2.7 kernel now compiles and passes `postlink-verify` as an
  ordinary optimized x86 ELF: 19,967,480 linked bytes become 14,617,792
  output bytes across 793,247 blocks. Selection is 200,731 direct, 591,688
  exact-source, and 828 erased blocks; 326 normalization escapes remain
  quality diagnostics. A synthesized body with an unbound linked relocation
  field is rejected during candidate selection; the exact source-x86 body
  remains available. This verifies the kernel ELF, not a boot or release.
- Two complete-state escapes were reconstructed directly from the plan:
  `wrfsbase rdx; jmp` and the published wide-constant `movabs; lea` above.
  The kernel-wide diagnostic moved 341 -> 339 escapes, with direct/source/
  erased 213,886/578,533/828 blocks and 10,460 retained escape bytes.
  `make -C src/v2 -k -j2 check` passed in the QEMU guest after both changes.
- The full native-closure diagnostic measured 1,090,600 linked instructions
  and 1,086,243 emitted instructions before publication gating. Its physical
  route counts are 213,970 direct, 578,449 source-retaining, and 828 erased
  blocks; the selected body is 4,263,565 / 4,288,016 source bytes
  (coefficient 0.994298). The 326 escapes retain 10,113 bytes and 625 plan-node
  delta. This is a diagnostic over an **unpublished** kernel body, not a
  distribution-size result. The maximum observed normalized work/span is
  211/65 at `0xffffffff815f3d77`, a separate large pure block to inspect
  after the first publish blocker.
- A source-lock identity defect was found during the upgrade: the toolchain's
  release-metadata package embeds all of `sources.env`, but its publication
  key omitted that file. The key now includes the source-lock digest, so
  unchanged toolchain components can be reused while changed distribution
  provenance republishes with a new identity. The rebuilt toolchain package
  set passed its static smoke checks, and its embedded source lock matches
  the current `data/sources.env` byte for byte.
- The updated util-linux 2.42.3 failed to compile `hook_idmap.c`: it uses
  `RESOLVE_NO_SYMLINKS` without including the Linux UAPI header that defines
  it. A version-specific, digest-keyed source patch includes
  `<linux/openat2.h>` without substituting a numerical flag literal for the
  kernel authority. The core-tools package set now builds successfully.
- The init, core-tools, toolchain, and system-tools package sets all built
  from the new source lock. A full `data/build.sh` run assembled those exact
  sets, staged BusyBox, and rebuilt the linked kernel. It then stopped at the
  then-current 341 kernel normalization escapes before producing a candidate
  root. The two compiler fixes have not yet completed that release build.
  There is no updated release-size, boot, or native-speed result to report.

## 2026-09-23 escape reduction

- The old detailed TODO recorded a tempting 339 -> 322 compare-tree shortcut
  on Linux 7.1.8, but `compare-cut-check` found that it reordered a comparison
  across a candidate-register publication and miscompiled an expression.
  The new direct compare-tree/select candidate preserves
  `tree -> CMP/TEST -> current/candidate MOV -> CMOV`; both register-owner
  orientations have exact emitted-byte regressions, and the 39,845,888-case
  compare differential remains green. This general grammar does not by itself
  reduce the Linux 7.2.7 escape population.
- The current kernel's live-output and construction-field projection exposed
  a different blocker: a dead instruction could be removed, but any linked
  relocation field in the block disabled the entire live-instruction frame.
  A retained instruction now projects each construction field by its exact
  source-instruction owner and surviving output offset. A field in an omitted
  instruction has no output owner; terminal control still requires an explicit
  fixup. `native-layout-check` covers both retained and omitted fields.
  This reduces 339 -> **335** escapes, 1,086,260 -> **1,086,250** emitted
  instructions, and 4,263,660 -> **4,263,593** selected body bytes. The
  actual `vmlinux.unstripped` relocation at `0xffffffff8121f732+4` projects
  to `0xffffffff8101f0b4`, retained, through the shortened body.
- Escape diagnostics now record the exact end, live-output mask, construction
  fields, and relaxation state used by the release-wide scan. Re-forming a
  sample with default liveness falsely advertised a direct candidate at
  `0xffffffff8121f727`; the exact projected sample showed that the linked
  construction field had disabled it. The first unresolved sample remains
  `0xffffffff81206a37` (8 source instructions versus 7 SSA nodes). A lower
  SSA node count alone is not an x86 physical lower-bound proof.
- The first 32 exact projected residual samples have distinct blocker classes
  (`0x200`, `0x282`, `0x600`, `0xf003`, and others), not one safe scheduling
  relaxation. Some are concrete floor artifacts. At `0xffffffff812314c9`,
  four SSA nodes coexist with
  three independent constant/copy publications. Do not pretend the SSA count
  certifies an x86 minimum or remove stage 244 wholesale. The next proof must
  distinguish mandatory publication cost from actual missing emitted work,
  then drive the largest remaining exact class down.
- The entry-RFLAGS branch grammar now also accepts one 32-bit zero-extension
  publication beside acyclic register copies. It schedules old-source readers
  before the zero-extension write, keeps MOVs before Jcc so entry flags survive,
  and projects the linked branch field. Exact output-byte coverage includes
  `0xffffffff81246595`'s shape: three required GPR publications plus one Jcc.
  Those four physical instructions are not reducible to the two pure plan
  nodes plus a control-shell charge; a direct frame now states this explicitly
  instead of retaining the source as an unexplained fallback. The kernel scan
  moves **335 -> 333** escapes and **213,895 -> 213,963** direct blocks, with
  unchanged selected body bytes and emitted-instruction count. This is a
  closure/proof advance, not a measured speed or size improvement. Full
  `make -C src/v2 -k -j2 check`, including the 39,845,888-case compare
  differential, passed in the QEMU guest.

## Complete 333-escape inventory

Before the next fix, `native-closure --escape-report` reconstructed **333/333**
exact projected blocks from the Linux 7.2.7 `vmlinux.unstripped`, including
the live-output mask and linked-field/branch-relaxation state. At that
baseline, all 333 had one
source-retaining candidate; together they contain 2,823 linked instructions
and 2,105 pure SSA nodes. That difference is **not** a recoverable-instruction
count: architectural output publications and terminal control cost real x86
instructions. No sample contains a fault predicate or a machine operation.

| Last diagnostic code | Blocks | Interpretation of the attempted grammar |
| --- | ---: | --- |
| `0x2xx` | 127 | ALU publication or register schedule |
| `0x6xx` | 51 | Expression-tree materialization |
| `0xf003` | 37 | Standalone final-flags publication not formed |
| `0x8xx` | 28 | Compare-branch publication |
| `0x000` | 26 | No specific blocker recorded |
| `0x4xx` | 13 | Shift publication |
| `0x7xx` | 11 | Compare-branch register schedule |
| `0x5xx` | 11 | Result-width inference |
| `0x3xx` | 10 | Other publication |
| `0xf100` | 10 | Compare-branch shape |
| `0xf002` | 5 | ALU frame shape |
| `0x1xx` | 4 | ALU projection |

These codes are the **last unsuccessful selector probe**, not mutually
exclusive semantic root causes or lower-bound proofs. Shape counts are 249
fallthrough, 66 conditional, and 18 jump blocks; 79 carry linked construction
fields. There are 254 distinct ordered pure-node opcode sequences, 220 of
which occur only once. The ten most repeated sequences cover only 62 blocks,
so one narrow hand-written template cannot close the population. The largest
repeat is a 12-block OR/XOR/AND/ADD family at `0xffffffff8140f542` and nearby
coordinates (11 pure nodes, 12 source/emitted instructions); its exact
dependency and publication floor must be inspected before calling the extra
instruction removable. The inventory is a diagnostic, not a faster or smaller
release result.

The first selected non-floor witness was
`0xffffffff813149be..0xffffffff813149c9`: `AND esi,0x80` → `MOV rsi,rsp` →
`JNE`. The AND result is dead, but its complete defined flags are live. Because
the mask excludes bit 15, `TEST si,0x80` preserves the defined ZF/PF/SF/CF/OF
outcomes of the 32-bit AND while leaving a register that the following MOV
overwrites. This narrows the flag producer from six to five bytes, with the
same three physical instructions. A mask containing bit 15 is rejected because
16-bit TEST would change SF. Exact generated-byte checks and native flag
differentials over seven boundary masks and 65,536 inputs per mask passed.
The whole-kernel diagnostic moves **333 -> 332** escapes and **4,263,593 ->
4,263,592** selected bytes; this is not yet a published distribution-size or
speed result. The four superficially similar `AND; MOV; MOV; Jcc` sites use
already-short immediate AND encodings, so this one-byte saving does not
generalize to them automatically.

## 2026-09-23 dominant publication bucket

The `0x2xx` diagnostic bucket was the largest at 127 blocks. Recording the
pending register mask and first blocked source/dependency pair separates 77
register-order stalls from 50 expression-emission failures; neither number is
itself a proof of missed physical work. For example, `die_addr+0x51` has
three pure nodes but four required architectural publications. In
`bpf_skb_net_hdr_push`, a two-operation `xchg; lea` would discard a live
`rax` publication at the call boundary; the source's three operations are
not removable on that local observation contract.

One real missed quotient in this bucket was the six blocks at
`0xffffffff815a12b6`, `0xffffffff815a1da4`, `0xffffffff815a203c`,
`0xffffffff815a4b4e`, `0xffffffff815a66c9`, and `0xffffffff815a6996`.
Each contains a zero-tested word, its bitwise-AND projection, and a CMOV
that selects zero for zero input. The value is just the AND projection:
`select(0, x & mask, x == 0) = x & mask`. TEST still publishes flags;
only the redundant value selection disappears. The rewrite also handles a
direct identity and reversed guard polarity; these extensions did not occur
in this kernel's remaining escapes. Positive and distinct-input negative
plan checks pass. The exact scan moves **332 -> 326** escapes,
**1,086,250 -> 1,086,243** emitted instructions, and **4,263,592 ->
4,263,565** selected body bytes. The `0x2xx` bucket remains at **121**
blocks (71 ordering, 50 emission): this is partial progress, not closure or
a published distribution. Full `make -C src/v2 -k -j2 check` passed after
the generalization.

## Next failing witness, in order

1. Discover correctness failures first, with ASan/UBSan, TSan, corner cases
   and source/generated/reference differentials. The fixed benchmark is
   sufficient for this stage by explicit user direction; its raw 1.002329099
   ratio stays recorded, not relabeled as a speedup. Shared selector epoch
   writes were red under TSan; the memo is now candidate-owned and bounded.
   An unaligned byte-arena base was red under UBSan and a direct support test;
   allocation now aligns actual addresses with overflow/capacity checks.
   Keep the 395 selector functions split into independent responsibility
   modules; do not recreate a monolith or a source-include compatibility path.
2. Attack the actual native body coefficient: the current passing kernel
   selects 225,464 direct, 588,976 exact-source and 746 erased blocks (815,186
   total), with 641 normalization escapes and maximum observed 229 work /
   65 span. These are block diagnostics, not whole-kernel performance.
   Compose across safe direct fallthrough/jump/call edges
   before selection, measure the resulting emitted instruction count, whole
   ELF bytes, and paired native execution. Inspect the largest repeated
   source-retaining shapes first; reducing heuristic escapes alone cannot
   yield a large release-wide size or speed gain. Every proposed fusion needs
   an exact linked input, control/fault cut proof, semantic differential test,
   and a measured work/span/length witness. In particular,
   a compare whose flags feed a conditional move while an entry register is
   overwritten must preserve the compare → publication → CMOV order; dropping
   that dependency previously miscompiled the `compare-cut-check` witness.
3. Preserve the accepted native bytes and checkpoints. After any compiler
   change, regenerate the whole owner-preserving ELF population and rerun
   signed root, exact-download, crypto/archive/HTTPS/development, full boot
   and fixed native comparisons. Do not reuse `3bc6150c...` or `53120f85...`
   rejected outputs. Keep the genuine linked-kernel baseline, rather than
   Kbuild's mutable `arch/x86/boot/bzImage`.
4. Finish the *entire* canonical release-word writer and measure its actual
   output, including all semantic families and boot/trust/package state.
   The 63.2 MB transport bundle and 251.8 MB canonical filesystem are not
   that word. Retain real non-joint Pareto cases rather than calling them
   global minima. Keep storage reduction separate from bake time and peak RSS.
5. Before public release, explicitly settle the publication timing policy,
   establish public signing authority and publish reproducible inputs and evidence.
   The current ordinary Linux root bundle is a functional local test-key
   candidate, not an unprivileged launcher or an autonomous disk image.
6. Only after the native gates, project the accepted x86 and authenticated
   release into Wasm/Storage; cold-boot the same Linux authority in a real
   browser and test an offline shell, C compile/run, `make`, package metadata,
   and granted Git/HTTPS. Record missing-block count and cold-ready latency.

The 75,000,000-byte canonical program-word limit remains unproven. Functional
native execution and whole-filesystem storage reduction are now verified;
native speed, canonical-word publication, public release and browser completion
are not. The retained current evidence, including the red speed report, is in
`artifact/native/verification/`.
