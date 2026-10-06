# Remaining work — 2026-10-06

## Fixed input and success

Use the published native OS Length3 Linux bundle:
publication `1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195`,
SHA-256 `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
Preserve the native publication and human UI.

The one product path is accepted optimized x86 ELF / real bzImage generation
-> independent cold C compiler -> bounded ordinary Wasm -> C vm.wasm.
Linux alone owns syscall, VFS, process, signal and network semantics.
No legacy machine pack, substitute kernel, QEMU/v86 product backend,
JS/Python guest interpretation, opcode skip or implicit execution fallback.

Acceptance is actual-browser PID 1/offline terminal, C compile/link/run,
make -j4, local Git and packages; authenticated minimum page/extent delivery;
dirty workspace commit/close/reopen; explicit file import/export; granted
virtual NIC curl/Git HTTPS and a guest service reachable at a browser URL.
Revocation, stale replies, corrupt cache and Worker restart must fail/recover
exactly. Measure fetch count/bytes, resident high-water and cold-ready
separately. Cold shell three seconds remains a target.

## Authoritative checkpoint

Latest completed `a305af4` run: PSRLDQ passes, 265,612,366 retired /
149,485,773 admissions. Guest s6 sync fails (Broken pipe / timeout), and
terminal stays down. HLT `f4` at `0xffffffff813efa53` is then -102.
Engine 725,454 ms, cold 595,693 ms, execution 158,080 ms,
total 1,764,466 ms; same quotas, not a speedup.
See [receipt](../vm/check/browser/evidence/2026-10-06-node-startup-service-timeout.json).
Next: full opt-in C source profile to distinguish quota/candidate/write
causes; faithful HLT idle/wake retirement; actual service/IPC/scheduling
failure under the existing explicit clock contract. No timeout/clock
relaxation or kernel wait skip. Normal VM is unchanged; six metric models
and source/MMU/fault/CPU checkpoint checks pass. See
[scope](../vm/check/browser/evidence/2026-10-06-source-profile.md).
Full Linux/browser/offline development/storage/network acceptance remains red.

Earlier:
Latest completed `3147e94` run: PCMPEQD passes, 242,172,992 retired /
133,002,483 admissions; PSRLDQ `66 0f 73 d9 08` at
`0x7f7289383862` is compiler -102. Same bounds and warmCuts=64.
Engine 576,295 ms, cold 473,120 ms, execution 127,113 ms,
total 1,418,360 ms, not a paired speedup. See
[receipt](../vm/check/browser/evidence/2026-10-06-node-startup-psrldq-red.json).
The independent candidate conservatively shares fixed transfers across
request caps and projects whole-byte region shifts/zero-default. Same 64-row
quota, metadata +8 bytes, VM/compiler 70,796 / 456,722 bytes.
464 native/cold emissions / 59,392 stable native observations, source/MMU/
fault/shadow models, native checks and scoped sanitizers pass.
NOT loaded in that completed run. See
[scope](../vm/check/browser/evidence/2026-10-06-budget-and-byte-region.md).
PID 1/root mount/shell/tooling/browser acceptance remain unachieved.

Earlier:
Latest completed `aa750ea` same-bundle run: 229,117,402 retired /
124,477,220 admissions; SHUFPS passes and PCMPEQD self-equality
`66 0f 76 c0` at `0x7f1159591ddb` is compiler -102.
Engine 507,555 ms, cold 421,207 ms, execution 113,947 ms,
total 1,261,153 ms; unchanged quotas, not a speedup comparison.
See [receipt](../vm/check/browser/evidence/2026-10-06-node-startup-pcmpeqd-red.json).
The separate shared binary candidate passes 432 native/cold emissions /
55,296 unchanged observations in direct and C dispatch, 2,992 common laws,
full compiler/CLI and shared-core/native sanitizers. Compiler 456,366 bytes;
VM unchanged. It deletes scalar packed-add/logic reconstruction and consumes
one lane-parametric law, including equality/identity/zero/ones substitution.
It is NOT in that completed run. See
[scope](../vm/check/browser/evidence/2026-10-06-vector-binary.md).
PID 1/root mount/shell/tooling/browser acceptance remain unachieved.

Earlier:
Completed `cfb0d28` Node run: 196,784,804 retired / 104,131,710 admissions;
-102 at `0x7f7baf27d340`, SHUFPS `0f c6 c2 00`.
Frozen VM/compiler 70,499 / 453,522 bytes, warmCuts=64, unchanged quotas.
Engine construction 356,170 ms, cold emission 301,678 ms, execution 87,149 ms,
total check 914,753 ms. Different work/clock calibration is not a speedup.
See [completed receipt](../vm/check/browser/evidence/2026-10-06-node-startup-shufps-red.json).

Shared-core/vector candidate: 3,078 decoded laws, 196,992 descriptor refusals,
408 native/cold byte-identical emissions, 52,224 stable native observations in
both direct and C-dispatch execution; full native compiler/CLI checks and
instrumented shared-core/native ASan/UBSan. Compiler 455,822 bytes, VM unchanged;
NOT loaded in that completed run.
See [derivation and scope](../vm/check/browser/evidence/2026-10-06-shared-x86.md).
PID 1/root mount/shell/tooling/browser acceptance remain unachieved.

## Next work, in order

1. Complete common construction.
   Instruction semantics and SSA composition/normalization/DCE/CSE/waves now
   have one owner in `x86`; old private copies are deleted. Vector permutations
   use one shared coordinate law. The old dedicated lower and historical
   VM/unowned benches are deleted.
   Scalar `emit-cut.c` still loops over instructions; `lower-register.c`
   still owns separate ALU/flags/address spelling. Make it consume the shared
   normalized transfer and delete replaced rules. Red-test emitted work and
   dependency structure against common normalization: merely linking that
   library does not prove backend use.
   Preserve exact faults/access order, live flags, partial registers, CPU
   profiles, aliases and continuation ownership. SSA is transient evidence,
   never another saved runtime format.

2. Measure the candidate on the same actual bundle.
   Freeze bytes/digests/commit and unchanged quotas. Observe the next real
   ISA/MMU/machine barrier and close general meaning, not a Linux-function case.
   Engine construction/repeated cold admission dominate: remove demanded
   reconstructions through exact identities/lifetimes, not analysis-only
   speedups. An /init announcement is not PID 1.

3. Close optimized-ELF and executable-generation admission.
   Whole-image `wasm-compiler INPUT.elf OUTPUT.wasm` remains -104:
   complete function/control/dispatch coverage is unpublished. Every required
   relinked instruction and precise fault cut must lower to the same ABI.
   Generated code/text mutations need fenced accepted generations, complete
   coverage and atomic publication outside in-flight execution.
   Raw-page diagnostics neither authenticate release nor prove total closure.
   No fabricated ELF, guessed continuation or execution fallback.

4. Retire remaining legacy consumers.
   `web/vm.js`, old Worker/Storage callers and old runtime catalog are not
   migrated by deleting the historical C source. Reconnect them to modern C
   Artifact/Storage/machine boundaries and delete obsolete readers/writers/
   catalog payloads together. Keep integrity/recovery tests; never obtain
   green by dropping validation or reviving STEP/interpreter execution.

5. Complete browser development acceptance.
   Real kernel/PID 1/root block device/offline terminal, then C/link/run,
   make -j4, Git/packages, bounded authenticated page/module supply, COW/root
   publication and exact close/reopen/suspend semantics. Connect granted NIC
   transport, HTTPS/Git and browser services without moving Linux meaning
   into an adapter. Run x86/signal/futex/clone3/exec/timers/ptrace/pipe/IPC/mm/
   tty/seccomp/net plus fault/revocation/stale-reply/corrupt-cache/Worker
   corners. Selftests remain data inputs, not release payloads.

## Contracts and evidence

[ARCHITECTURE.md](../docs/ARCHITECTURE.md) records current ownership/path.
[CONTRACT.md](CONTRACT.md), [BENCHMARK.md](BENCHMARK.md),
[ARTIFACT.md](../docs/ARTIFACT.md), [STORAGE.md](../docs/STORAGE.md) and
[BROWSER.md](../docs/BROWSER.md) retain the full publication/acceptance contract.
Fixed recipe/workloads/native bundle/upstream identities are unchanged.
The SDK helper invokes product Makefiles; native/cold builds share x86
`sources.mk`. Historical measurements retain their original build/scope in
evidence, not as current pending tasks.
