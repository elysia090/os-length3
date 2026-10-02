# Common control writes and memory observations — 2026-10-02

Goal remains active: the **same published OS Length3 Linux bundle** must reach
browser Linux/PID 1, offline shell, C compile/run, make -j4, local Git and apk;
then authenticated bounded storage/commit/reopen and granted NIC HTTPS/service
publication. Probe success and instruction counts do not complete that goal.
Linux remains the syscall/VFS/process/network authority. Native release bytes
and human UI are unchanged; no new size/speed or cold-shell timing is claimed.

This extends the [28-instruction receipt](2026-10-02-control-read.md), without
editing its historical bytes. Actual ordinary-memory browser Worker execution
now retires **48 shipped bzImage instructions** through the cold C-Wasm compiler
and C VM/MMU/table. CR4 write, configure_5level_paging's entry, memory CMP/JNE,
its BSS store and actual CALL get_cmdline_str execute. The target page also
comes from the exact bundle; the next true grammar red is **`0x12e2a96`,
`SHL RDI,32`**. Full 1,256-byte CPU state, 136-byte hidden caches, the independently
specified conditional branch, stack return/saved registers and BSS value agree.
Linux boot, PID 1, terminal and product storage/network remain **not achieved**.

## Common boundaries

MOV to CR0/2/3/4/8 is one generated cut importing the C function
`machine.control(private_port, rank, value)`. Rank identifies an architectural
register, not an opcode/source interpreter. The generated code owns operand
loads, RIP and retirement. The C boundary validates generation, long-mode hidden
cache/context and CPL, then the complete write before publishing one state word.
Failure does not change CPU/cache or retire. Arithmetic flags are undefined;
their incoming values are a selected representative, not a hardware flag oracle.

The fixed 40-physical-bit CPU contract exposes CR4 TSD/PSE/PAE/PGE/PCE/OSFXSR/
OSXMMEXCPT only. The test independently derives that mask from the x86 admission
profile, so a feature change cannot silently widen only one product. VM core
still imports no decoder/compiler headers. Other execution modes are admission
failures, not invented guest faults. CR0's low reserved bits are ignored and ET
is fixed one; high bits, PG/PE and NW/CD violations fault. CR3 ignores low 2:0
and 11:5 but retains PWT/PCD; bits >= MAXPHYADDR, including no-flush bit 63 without
PCID, fault. CR4 reserved bits/cleared long-mode PAE and CR8 high bits fault.
CR2 accepts arbitrary 64-bit addresses.

Every successful control write revokes executable-context admission, even
equal-value CR3/CR4. The next call cannot reuse old fetch proofs. No TLB is
retained; adding one requires architectural invalidation at this boundary.
Reservations are aborted on entry, including stale/invalid/faulting writes.
The synchronous serialized single-owner boundary is not LOCK/SMP atomicity.

Memory CMP/TEST imports the existing READ-only access function, computes
arithmetic/flags with the same generated ALU lowering, and never writes a GPR
or payload. A memory first operand is **not** a write transaction. A failed read
cannot publish flags; TEST's undefined AF is canonically cleared and excluded
from native-defined-flag comparison. No VM opcode callback was introduced.

## Exact observations and checks

* VM: **16,103 bytes**, SHA-256
  `0ac4dd65e0801382538ca263a2c85eb764a89b69caf8b724a6cb513843dc8176`.
* Cold compiler: **405,138 bytes**, SHA-256
  `ad2eb59199d8a0e31ffa0f6724faf834846e7e86b6ac61936fd667de69d61512`.
* Native bundle remains **63,219,311 bytes**, SHA-256
  `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
* Browser receipt [2026-10-02-startup-control-write.json](2026-10-02-startup-control-write.json):
  48 retired source instructions, 44 rows, 15 checked recompiled admissions,
  524,288 VM memory bytes and 1,048,576 cold memory bytes; secure context,
  ordinary memory, no isolation. Those extents are **not Linux RAM/RSS or
  memory-reclamation measurements**. The local fixture SHA manifest is not a
  signed production root/code admission. Re-admission still recompiles all
  supplied rows after conservative write/context revocation; no optimized
  disjoint-write proof or demand-only recompilation is claimed.
* Missing control-write implementation was red before implementation.
  486 native specification-model cases now pass; 80 generated modules pass
  23,360 model cases through actual C-Wasm, plus equal-write revoke, stale port,
  alias/bounds, TF/RF/VM and failed-write reservation cancellation checks.
  These are **not a hardware CPL0 fault/exception-entry differential**.
* Memory CMP fixture initially compile-refused with -102. Sixteen post-linked
  CMP/TEST modules then pass **8,192 actual native-x86/C-Wasm comparisons**.
  Operand order, 8/16/32/64 bits, high byte, negative immediate, 32-bit address,
  scaled address and split-page noncommit are covered.
* Existing 83 pure / 42,496, 22 memory / 11,264, 22 RMW / 11,264 and
  11 stack / 5,632 comparisons remain green with the updated VM.
* Native C/cold C-Wasm agree in **362 byte-identical emissions**, including
  repeat/growth/rejection checks, all old families and new control/CMP fixtures.
* Full `make -C src/v2 -j2 check`, VM and compiler ASan/UBSan pass without
  compiler warnings or sanitizer errors.

## Reproduce

Use native C build tools, GNU tar/zstd, Node and the pinned official Wasm SDK.
No WSL build or alternative browser x86 emulator is required.

```sh
bash data/oracle/prepare-startup-cuts.sh BUNDLE.tar.zst \
  4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc \
  temp/new-startup
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/prepare-browser-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/serve-browser.mjs --port=8080
# Open /src/v2/vm/check/browser/startup.html in an actual browser.
```

The preparation script validates the archive before extraction and the exact
kernel digest before these fixed witness coordinates. New output directories
are required. Source pages are borrowed, never fake ELF or zero-filled code.
Only the loader initializes a reconstructible initial BSS page; dirty suspended
memory is not replaced by boot initialization. Scripts prepare partial cuts,
not whole-image closure. Missing coordinates still fail, never interpret/skip.

Next: general register shifts, with count-zero flags preserving prior live
definitions, then the actual command-line/decompressor path and exception/device/
root boundaries. Whole-image -104 and browser development acceptance stay red.

Sources: [Intel SDM Volume 2B, MOV control](https://cdrdv2-public.intel.com/868141/253667-089-sdm-vol-2b.pdf),
pages 4-32–4-34; [Volume 2A, CMP](https://cdrdv2-public.intel.com/868140/253666-089-sdm-vol-2a.pdf).
