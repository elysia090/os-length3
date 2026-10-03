# Common store/ALU/condition lowering — 2026-10-03

Linux boot, PID 1, offline shell and development/network/storage acceptance
remain **red**. This is actual shipped startup execution, not a replacement
kernel, an interpreter, an instruction skip or a whole-image closure proof.
The goal remains the complete browser Linux environment in BROWSER.md.

## Exact inputs and build

The published 63,219,311-byte `os-length3-linux` bundle is unchanged:
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
The kernel/initramfs/BusyBox identities are retained in the
[browser observation](2026-10-03-startup-stos-alu-cmov.json). No native release
or human-facing UI file changed. No WSL/NixOS input was used.

* C VM: 20,799 bytes,
  `d6b9f9a5732f90f9e1b7cfc5c9a9350a12eb1af53d598e065930a7a75dd8f6f8`.
* C cold compiler: 410,067 bytes,
  `6af3c006b986a69c7fc71d222f9f17752c586728b4fda8996b33f9afdb3c196c`.
* Compiler and VM import only their separate ordinary `machine.memory`.
  Generated guest cuts import the C memory/machine boundary, never a JS decoder.

## Red before implementation

All eight width/address-size forms of REP STOS failed the existing common
code-cut compilation/report assertions before store lowering was added.
The previous browser checkpoint stopped at the unchanged `REP STOSQ` bytes
`f3 48 ab`, relocated RIP `0x1e20d17`, with compile `-102`.

After that gate was removed, real startup reached `ADD r64,[memory]` at
`0x1e258e1`. A post-linked ordinary ADD fixture (memory case 62) reproduced
`memory cut refused (-102)`. After common memory-source ALU lowering, the
next gate was register CMOV at `0x1e25674`. Its post-linked 32-bit fixture
reproduced `real optimized ELF cut emission: red (-102)`.

The emitted-module engine cache also initially failed its pending-close test:
close cleared imports while an engine compile was awaiting. It now checks
the owner after compile and after instantiate and never publishes into a
closed owner. This cache is host engine machinery, not guest interpretation.

## Common implementation and independent checks

REP STOS uses the same bounded repeat loop, C MMU/store and in-flight
continuation as MOVS. It reads the operand-width accumulator once, neither
loads through nor updates RSI, preserves RAX/flags, and publishes only RCX/RDI
on partial return. Completion updates RIP/retirement once. All widths
8/16/32/64, address sizes 32/64, DF directions, zero counts, unaligned and
cross-page stores, code aliases and quantum/resource continuations are tested.
F2 STOS, FS/GS string addressing and exception delivery are not newly claimed.

Actual x86 STOS receipts: 336 complete CPU/RAM and 44 forward/backward fault
records. Actual C vm.wasm comparisons: 336 complete cases, 144 bounded latch
resumes, 192 entry/stale refusals, 66 partial/fault/miss cases and two code-alias
continuations. MOVS remains green at 336/144/192/88/two respectively. Fault
frames are native observations and pending C cuts, not browser exception entry.

Memory-source ADD/SUB/AND/OR/XOR use read-only C access and the same arithmetic/
flag helper as memory CMP/TEST and RMW. Destination and effective address are
captured before the potentially faulting read; parent register/flags remain
uncommitted on failure. Twenty-six post-linked modules cover all integer
widths, AH, address/destination aliases, index/displacement, address-size-32,
SS and RIP-relative forms: **13,312 complete native/C-Wasm comparisons**, plus
the existing provider stale/closed/missing/#PF/noncommit checks. FS remains an
explicit rejected form. Existing 22 RMW modules/11,264 comparisons remain green.

Register CMOV uses the shared 16-condition helper without branching into a
source interpreter. Its flag read joins the reverse liveness frontier even
when a later operation kills flags. Actual x86 validates false-condition
32-bit parent zeroing, 16-bit upper-parent preservation, all 16/32/64 widths,
self-aliases, another destination GPR and an interior ADD -> CMOV -> XOR:
**51 modules / 26,112 complete comparisons** in direct Wasm and separately
through the C table dispatcher. Memory-source CMOV is not implemented here.

Native C and cold C-Wasm emission are byte-identical in **431** bundle and
fixture modules. `make -C src/v2 -j2 check` passes. Selected compiler/lowering
tools pass ASan/UBSan (STOS/code-cut, native repeat, memory-source ADD and the
CMOV interior-frontier fixture); linked support/decoder provider archives in
that sanitizer run are the normal build, not a claim of whole-TCB coverage.

## Actual browser observation

The standard in-app Browser API opened `startup.html` in a background tab;
after rebuilding, the tab was explicitly reloaded. It observed secure context,
ordinary memory and no isolation. The screenshot is retained locally at
`temp/browser-stos-alu-cmov-1003.png`. The JSON is a labeled selection from the
visible receipt; trace arrays are omitted, numerical values are unchanged.

The independent complete 86-instruction CPU/cache and 378-instruction
relocation-register observations still pass. Every relocated kernel byte
(3,040,256), every REP BSS byte (98,656) and three scalar zero-fill returns
(16 + 16 + 131,072 = **131,104 bytes**) are independently checked through
C-borrowed views. These fixed diagnostic observations do not alter guest RIP,
registers, branches, RAM semantics or retirement.

The tiny 16-byte memset terminates; a later 128 KiB memset merely exceeded
the old 4,096-admission probe quota. The diagnostic now allows 300,000
admissions / 500,000 retired instructions and reports quota exhaustion as
such, never as boot. It reaches **328,375 retired source instructions** with
262,536 demanded admissions, predominantly scalar memset iterations. This
is not a kernel coverage percentage or an `/init` progress estimate.

The next exact unsupported bytes are `41 ff 14 24`, near indirect
`CALL [r12]`, at `0x1e25239`, compile `-102`. Initial page-table construction
has begun; startup/decompression, exception delivery and kernel boot have not
completed. No fallback was invoked.

## Fixed costs measured separately

`CompiledModules` retains at most 64 engine instances / 256 KiB of emitted
bytes for one Worker owner. Each request **still succeeds through the C cold
compiler first**; only byte-for-byte identical emitted Wasm reuses an engine
instance. Body changes, caller-arena reuse, entry/byte quotas, memory growth,
invalid modules, independent memories and pending close have regression tests.
The active function table still has one live slot. No source decode, guest
control choice or access callback is implemented in the engine cache.

Browser: 221 engine compilations, 262,315 exact-body hits, 64 retained instances
with 19,657 emitted bytes. This eliminates the repeated engine instantiation,
**not** repeated C analysis or per-cut page copying: cumulative cold writes are
81,191,499 emitted bytes and 1,075,351,552 transported code bytes. They are
cumulative work counters, not resident/delivery size. The single-owner source
and CPU context remain pinned across async engine work; concurrent mutation
or production source attestation is not established.

Browser sub-timings: C construction 1,836.6 ms; engine work/reuse 864.7 ms;
C execution 188.3 ms; physical supply 241.2 ms. They exclude initial object
fetch/setup and diagnostic assertions; their sum is **not cold-shell time**.
The 3-second cold-shell goal is unmet. Delivery stayed at 47 HTTP 206 reads,
3,056,640 fetched bytes, 65,536-byte chunk cache. There are 1,549 resident
pages, 6,815,744 VM memory bytes and a separate 1 MiB cold memory.
Production signed-root/AEAD/ECC admission, clean-page eviction, dirty recovery
and browser grants/network remain red; local SHA-256 chunks do not prove them.

## Reproduction / next gates

Build with `data/oracle/wasm-tools.ps1 -Compiler`; generate actual native
fixtures with `prepare-memory-alu-cuts.sh` and `prepare-cmov-cuts.sh`.
Run `check-repeat.mjs` separately with `movs` and `stos`, `check-wasm-provider.mjs`,
`check-wasm-cuts.mjs`, `check-wasm-dispatch.mjs`, `check-cold-compiler.mjs` and
`check-compiled-modules.mjs`. Feed the same bundle fixtures to
`check-wasm-startup.mjs`; prepare `generated-startup` with
`prepare-browser-startup.mjs` and open the real `startup.html`.

Next: common indirect CALL with independently tested target-read/#GP/stack-
reservation fault ordering; C-owned reusable source admission that removes
reanalysis/page-copy work without stale code aliases; crossing-first-fetch
supply; the remaining startup/exception/device/root boundary. Keep the full
Linux/PID 1/offline development and browser storage/network goal intact.
