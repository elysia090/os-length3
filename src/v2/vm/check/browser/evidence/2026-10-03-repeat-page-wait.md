# Compiled REP continuation and physical page wait — 2026-10-03

The same published bundle now passes the previously RED REP MOVSQ grammar
gate in an actual ordinary-memory browser Worker. It still retires **378**
startup instructions: the first relocation destination is not resident.
Linux boot/PID 1/development, storage/network acceptance and cold shell
three seconds remain RED. Native bundle and human UI are unchanged.

## One common compiled instruction

Eight REP MOVS forms (8/16/32/64-bit operands × 32/64-bit addresses) lower to
ordinary Wasm locals/loop/select/arithmetic and the existing typed C
`machine.access` import. There is no C/JS instruction callback. FS/GS bases,
other string families and alignment/debug/interrupt delivery remain open.

For each completed element, with address-width mask M and DF stride d:

```
value = read(RSI & M, element_bytes)
write(RDI & M, element_bytes, value)  // both fragments preflight before payload
(RCX, RSI, RDI) = ((RCX - 1) & M, (RSI + d) & M, (RDI + d) & M)
d = DF ? -element_bytes : element_bytes
```

The next element cannot commit before both accesses succeed. Locals carry
the three-register frontier, published only on a return; there is no per-
element CPU-frame copy or three-register materialization. Zero count
performs no memory access. Address-size-32 zero-extends the three parents at
instruction start, including zero count and first fault. That detail was
initially RED against native execution and then fixed, not assumed.

At most 256 elements execute per call. Remaining work returns
`BARRIER/QUANTUM` (10), a physical miss returns `BARRIER/RESOURCE` (2), and a
guest fault returns its existing typed fault token. None retires the
unfinished instruction or advances RIP. Successful completion retires once.
The C dispatcher keeps one 24-byte compiled-entry latch, not a CPU snapshot,
across the two barriers. It does not refetch/redecode possibly self-modified
source bytes. Ordinary admission remains revoked by any RAM/A/D write;
only this already-started instruction may finish. Completion/fault clears
the latch; context change, close/reopen cancels it. Wrong generation/port
does not consume a valid pending continuation. MOV SS shadow is consumed
only at final retirement.

This is a serialized pinned-owner contract, not SMP/async authenticity,
module eviction, exception entry or IRQ delivery. The table slot and machine
context must remain pinned across a wait.

## Independent red-to-green checks

* Native x86 observer: **336** complete implicit-parent/RAM records and
  **44** first/partial page-fault records. Widths, both DF directions, counts
  0/1/7/255/256/257/513 and forward/backward element overlap are covered.
  The build host's recorded projection is QEMU/WHPX; this is an external
  native instruction oracle, never the browser runtime or a performance result.
* Generated Wasm through actual C MMU/table dispatch: complete 1,256-byte CPU
  and 16 KiB payload comparisons at each return, **144** bounded continuation
  returns, **192** entry/stale refusals and **88** partial/fault/miss checks
  (including those 44 native fault records). No retirement at a partial cut.
* Two actual source-code alias cases overwrite the instruction's own bytes
  while the original compiled entry continues to completion. A subsequent
  entry stays revoked; no interpreter or stale fresh admission.
* Faulting cross-page elements write no partial payload. Saved native fault
  context's RF bit belongs to exception delivery, which is still unimplemented;
  it is not silently copied into pre-delivery architectural state.
* Core C tests were first RED for latched resume after a writing yield.
  RESOURCE/QUANTUM, stale generation, changed context/RIP, fault release,
  close/reopen and MOV SS preservation now pass.
* Full `make -C src/v2 -j2 check`, fresh ASan/UBSan VM checks and fresh
  compiler admission/code/fetch checks pass. Sanitized compiler dependencies
  are the existing native libraries; this is not a whole-distribution sanitizer
  claim. The deliberate native SIGSEGV observer is not an ASan test.
* **74** fresh bundle/repeat native/cold byte-identical emissions;
  198 SETcc modules / 101,376 comparisons, 20 code views, CPUID and
  stack-flags matrices remain green against the new VM.

## Actual browser gate

[Browser JSON](2026-10-03-startup-repeat-page-wait.json) records 189 admissions,
one reused live table slot and zero manual branch entries. The independent
complete CPU/cache witness at instruction 86 and relocation-register witness
at 378 still pass. At `0x1000281`, C requests:

```
result          BARRIER/RESOURCE (2)
physical range  0x1e283f8 + 8 bytes
access          WRITE | PHYSICAL_REQUEST (18)
completed       0
source retired  0
RIP/RCX         unchanged
```

This is a true physical miss, not a fabricated #PF or skipped copy. The next
implementation must supply the necessary page without vm_open/reset, full
RAM/root reconstruction, repeated sorted-directory shifts, or a JS MMU.
No async page completion/recovery is claimed here.

* Native bundle: **63,219,311 B**, unchanged SHA-256
  `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
* C VM: **17,017 B**, SHA-256
  `9596bb24e92dc7469b436cfe5014d442a0b8a928fa47f825769e096a019abc7a`.
* Cold C compiler: **408,885 B**, SHA-256
  `fb9d1f8e092ee65c372b8df9d526fd83a34d709caba74782cf7d6b837832c552`.
* Emitted bytes **60,442**; transported code bytes **774,144**.
  VM **524,288 B** and cold memory **1,048,576 B** are diagnostic arenas,
  not Linux RSS. One sample: cold calls 6.8 ms, engine 19.0 ms, C execution
  3.1 ms; excludes fetch/Worker, not shell timing or controlled speedup.

```sh
make -C src/v2 -j2 check
mkdir temp/new-repeat
src/v2/wasm-compiler/build/code-cut-check temp/new-repeat
src/v2/wasm-compiler/build/repeat-check temp/new-repeat/native.bin temp/new-repeat/fault.bin
node data/oracle/check-repeat.mjs VM.WASM temp/new-repeat
bash data/oracle/prepare-startup-cuts.sh BUNDLE.tar.zst \
  4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc temp/new-startup
node data/oracle/check-cold-compiler.mjs COMPILER.WASM temp/new-startup BUSYBOX.elf temp/new-repeat
node data/oracle/prepare-browser-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/serve-browser.mjs --port=8080
# Standard browser control: /src/v2/vm/check/browser/startup.html
```

The bounded source fixture manifest is local SHA-256, not signed production
admission. Whole-image -104, general page supply and kernel/device/root boot
remain red. Historical receipts are unchanged.

Reference: [Intel SDM Volume 2B](https://cdrdv2-public.intel.com/868141/253667-089-sdm-vol-2b.pdf),
MOVS pages 4-105–4-108 and REP pages 4-554–4-555.
