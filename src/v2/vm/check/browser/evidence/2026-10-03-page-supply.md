# Shipped bzImage relocation: actual browser page admission

On 2026-10-03 the standard Codex in-app browser opened
`http://127.0.0.1:8080/src/v2/vm/check/browser/startup.html`. Its ordinary-memory
Worker completed the shipped `REP MOVSQ`, compared the entire 3,040,256-byte
relocation through C-MMU-borrowed views and the complete CPU/cache observation,
then advanced to 385 source instructions. The next red gate is C cold compilation
of `jmp rax` at `0x10002a1` (`-102`). **Linux/PID 1/shell are not achieved.**

The [raw UI receipt](2026-10-03-startup-page-supply.json) was read after reloading
the final transport source. The screenshot is locally retained at
`temp/browser-page-supply-1003.jpg`. The browser observed secure context and
no cross-origin isolation; shared memory, IRQ delivery and RSS reclamation were
not tested. Native bundle and human UI bytes are unchanged.

## Inputs

The source is the same 63,219,311-byte published native bundle, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
Kernel/initramfs/BusyBox digests are in the raw receipt. No new bake, WSL kernel,
unshipped vmlinux or alternate interpreter was used.

* `vm.wasm`: 20,799 bytes, SHA-256
  `d6b9f9a5732f90f9e1b7cfc5c9a9350a12eb1af53d598e065930a7a75dd8f6f8`.
* Cold compiler: 408,885 bytes, SHA-256
  `fb9d1f8e092ee65c372b8df9d526fd83a34d709caba74782cf7d6b837832c552`.

## Physical and transport boundaries

Initial and appended resident rows use one C crit-bit index. With R resident
pages it needs R 32-byte rows and R-1 16-byte branches; no table proportional to
logical guest RAM, sorted insertion, directory copying or VM reopen is needed.
Branch bits strictly decrease, so an aligned-u64 coordinate takes at most 52
branches. The exact-tag 256-entry pointer front is transient residency scratch,
not an immutable Artifact quotient or a proof of global optimality.

C latches the actual MMU physical miss. It chooses a virgin payload slot and
returns an exact initial object extent plus a non-wrapping per-instance ticket.
Retry retains the same ticket without re-zeroing. Generation, port, request and
CPU/MMU/RIP checks fence commit. An already resident row cannot be reinitialized,
even on a permission miss. No eviction is permitted: dirty RAM stays resident.
`vm_grow` only refreshes the stable payload extent; the CPU and REP/table latch
are not reset. All rows/table slots/context remain pinned by one serialized owner.

The browser supplied 1,481 pages, retained 1,494, and resumed 1,483 bounded REP
quanta without recompiling that in-flight instruction. 4 KiB residency is distinct
from 64 KiB diagnostic delivery: 47 exact HTTP 206 Range requests fetched
3,056,640 object bytes, for 3,022,848 requested source-extent bytes. The retained
delivery cache high-water was 65,536 bytes. Streaming length/Content-Range and
chunk SHA-256 are checked before copying to the C staging slot. This is a local
diagnostic manifest, **not signed production root/AEAD/ECC admission**.

VM linear memory reached 6,815,744 bytes; cold memory was 1,048,576. The explicit
4,096-resident-page quota reserves 196,592 descriptor/index bytes; it is not a
word per logical RAM page. Timings in the receipt separate cold C compilation,
engine compilation, execution and supply, exclude earlier fixture fetch/setup
and independent observation, and do not establish cold shell within 3 seconds.

## Checks

* Missing page-supply exports were first red against the preceding VM.
* Native page index: 2,048 unsorted appends, 200,000 exact/colliding/missing
  lookups, structural bit-descent and invalid/capacity/reservation rejection.
* Native supply: retry, context/stale/replay, resident refusal and UINT64_MAX
  ticket-wrap refusal. Fresh Workers still require supervisor incarnation fencing.
* Actual C-Wasm lifecycle: 128 pages, real extent growth and descriptor exhaustion,
  wrong/replayed tickets, changed context, revocation, dirty protection and
  cross-page noncommit. Refusals do not publish private output.
* Transport: shared/cross-chunk reads, corrupt/short/oversized/HTTP 200 refusal;
  failed bytes are not cached, and a fresh valid retry succeeds.
* Full product `make -C src/v2 check` and VM ASan/UBSan checks pass; CPUID,
  PUSHF/POPF, REP/native partial-fault and memory RMW/provider regressions pass.

Reproduce using `prepare-startup-cuts.sh` on the pinned bundle, build the C VM,
then run `check-page-supply.mjs`, `check-extent-reader.mjs` and
`check-wasm-startup.mjs`; `prepare-browser-startup.mjs` retains the exact two
source objects for bounded Range serving and `startup.html` runs the same check.
Next: common indirect control, decompressor/startup ISA, interrupts/devices and
real Linux shell. Production authenticated storage, cold eviction/recovery and
the offline development/network acceptance matrix remain red.
