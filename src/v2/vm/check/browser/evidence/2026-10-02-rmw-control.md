# Actual browser startup checkpoint — 2026-10-02

Linux boot is **not achieved**. The unchanged published native bundle now
executes 26 actual compressed-kernel startup instructions in the Codex in-app
browser's ordinary dedicated Worker. This is an automated browser observation,
not the earlier user-supplied provider receipt or only a Node result.

The standard browser-control route succeeded without startup flags or a sandbox
bypass. The restricted diagnostic server retains its CSP; the page uses external
same-origin modules, not inline script or general `unsafe-eval`.

## Exact builds and input

* `vm.wasm`: 15,329 bytes, SHA-256
  `c05f4a97d4292a7d3cc7e6263491cd066b4d3bebe430d1d6af5d9f27d98e3cb9`.
* Cold `wasm-compiler.wasm`: 403,325 bytes, SHA-256
  `a9c5563e015b660aeb89bc050ee9f2b91cc08c635328f43ff4b30c80caa45b75`.
* Source: the same `os-length3-linux-v0.1.0-rc.1` native asset,
  SHA-256 `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
  Kernel/initramfs/BusyBox digests remain in the separate startup JSON receipt.

Both C modules import only `machine.memory`. Generated cuts import typed C
memory/segment/table/return functions; they do not import JS instruction or
memory semantics. Cold compiler and VM have separate static/stack memories.
The browser's 524,288-byte VM memory and 1,048,576-byte cold memory are fixture
linear-memory sizes, not Linux RAM requirements, process RSS or reclaimed RSS.

## What advanced

The shipped entry previously stopped after 14 instructions at memory ADD
`0x1000232`. It now runs that RMW, LGDT, selector/RIP PUSH, the real same-CPL
64-bit far RET, CALL, `load_stage1_idt`'s LEA/store/LIDT and near RET.
The next uncompiled coordinate is **`0x100024d`, MOV CR4,RAX**.

The 23 generated cut rows are built by the cold C-Wasm compiler from the actual
resident pages and compared with native C emission. Seven admissions follow
conservative write revocation. All 1,256 CPU-state bytes and 136 hidden-cache
bytes match independent fixed expected observations, including GDTR/IDTR,
CS cache, stack return coordinates, flags and 26 retirements. The JS validator
sets up fixtures and checks fixed observations; C dispatch chooses execution
coordinates. It does not decode or execute guest instructions.

The locally SHA-256-bound fixture manifest only detects stale/corrupt diagnostic
serving. It is **not** authenticated production module admission, full CPU
closure, Linux boot, exception delivery or a hardware CPL0 fault oracle.

## Shared boundary and red regressions

RMW ADD/SUB/AND/OR/XOR at 8/16/32/64 bits uses one C MMU reservation for at most
two physical fragments. All translations/rights must succeed before payload
read; generated Wasm computes the arithmetic/flags and commits once to pinned
physical destinations, without a second page walk. A failed commit also consumes
the private reservation. Access, failed/new reserve, abort, rebind/reopen and
cut exit revoke it. A host trap needs supervisor abort or Worker disposal before
reuse. Serialized context/residency is a precondition, not LOCK/SMP atomicity.

Tests caught two real regressions: combined READ|WRITE incorrectly accepted
only one physical right, and far RET skipped the descriptor Accessed write
because its future cache had already normalized A=1. The fixes preserve
write-intent #PF and original-descriptor fault behavior. MMU A/D writes can occur
before a later fault; payload/CPU state must not be partially committed.

LGDT/LIDT preflight a ten-byte source record before changing CPU state. Far RET
preflights its sixteen-byte stack record and descriptor, checks privilege/type,
presence and canonical target, then commits CS cache/RSP/RIP. Outer-CPL and
compatibility transitions remain explicitly unsupported, not fabricated #GP.

## Checks

* Full `make -C src/v2 -k -j2 check`, VM ASan/UBSan and compiler ASan/UBSan pass.
* C MMU: 49,152 permission combinations; 22 table-record placements;
  4,096 far-return selector/privilege/access-byte combinations, plus failure,
  reservation/cross-page/alias/reopen guards. These are model checks.
* 22 new RMW modules: 11,264 comparisons with actual native x86 execution.
  Undefined AF for logical operations is excluded from the semantic comparison.
* Native C / cold C-Wasm: 165 byte-identical emissions, including growth/repeats,
  over the real startup/BusyBox prefixes and pure/memory/stack/RMW fixtures.
* Real browser `provider.html`: v3, 512 native comparisons, secure context,
  ordinary memory, no cross-origin isolation.
* Real browser `startup.html`: 26 instructions, 23 rows, seven admissions;
  `linuxBoot: not-achieved`. Both ordinary-memory JSON receipts are retained.

No native re-bake, distribution size/speed improvement or human-UI change is
claimed. No isolated-browser or actual RSS-reclamation result is claimed.

## Reproduce

Use a Linux C build environment (the local build guest is not the browser's
execution backend), GNU tar and zstd. Existing outputs are refused:

```sh
bash data/oracle/prepare-startup-cuts.sh BUNDLE.tar.zst TRUSTED-SHA256 temp/new-startup
bash data/oracle/prepare-rmw-cuts.sh temp/new-rmw
```

The startup witness pins this shipped kernel digest before using its explicit
source coordinates. It is diagnostic construction only; whole-image publication
still fails `-104`. Build the two freestanding C modules with
`data/oracle/wasm-tools.ps1` (and `-Compiler` for the cold module), then:

```sh
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/prepare-browser-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/serve-browser.mjs --port=8080
```

Open `/src/v2/vm/check/browser/startup.html`. The Worker verifies bounded
fixtures, runs the same shared validator, reports JSON and is terminated.
Next: common control-register semantics, remaining actual decompressor operations,
complete executable/context attestation, exception entry and required devices.
Do not skip instructions, change the kernel or select another interpreter.

Architectural reference: [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Volume 2A LGDT/LIDT and Volume 2B RET; precise fault entry is still separate work.
