# Interior conditions and demand admission — 2026-10-03

The same published OS Length3 Linux bundle now retires **351** source startup
instructions in an actual ordinary-memory browser Worker. Linux boot/PID 1,
offline development, authenticated durable workspace, granted NIC HTTPS/service
publication and the three-second cold-shell target remain RED. The native
release and human UI are unchanged. This extends, not rewrites, the historical
[86-instruction receipt](2026-10-02-shifts.md).

## Common flags dependency, not a kernel-function special case

For each instruction, let R be its incoming flag uses, K its unconditional flag
kills, and W the definitions it may perform. Starting with every outgoing
architectural flag live, the reverse substitution is:

```
wanted definitions = live_out & W
live_in = (live_out & ~K) | R
```

A variable-count shift has K = 0: at count zero it preserves the predecessor.
SETcc reads only its condition's CF/SF/OF/ZF/PF subset and kills none. Thus a
CMP -> SETcc -> ADD retains the CMP bits consumed internally, even though ADD
kills the outgoing flags. Each source offset and wanted mask occupies one
packed 32-bit frontier word, at most 4 KiB for 1,024 source instructions. Forward
source validation, reverse dependency and emission are linear passes. There is
no decoded instruction array, predecessor CPU frame, heap or guest opcode
callback. This is exact liveness for the admitted grammar, not a claimed global
minimum of arbitrary x86 programs. ADC/CMOV/CMC are still not admitted.

All 16 register SETcc conditions use the existing condition helper and parent
register write path. Initial flags, CMP with a later flag kill, AL/AH/CL/CH,
REX byte registers, 32-bit parents and composed conditional shifts are covered.
Before this change, post-linked SETO AL refused with -102. Afterwards **198
modules / 101,376 native cases** agree with direct Wasm and the actual C VM
table dispatcher. Existing **156 shift / 79,872** cases and **16 memory CMP/TEST
/ 8,192** comparisons remain green.

## Code admission follows C-translated RIP

The browser no longer receives an enumerated branch-entry list or any native
prefix Wasm module. C `vm_code` walks the exact requested RIP, checks fetch
permission, and returns a borrowed resident 4 KiB page offset. Guest virtual
address, physical address and wasm32 offset are not conflated. NX/fault/pending
residency preserve output; A-bit writes remain visible and revoke prior code.
The wrapper rejects private-output/state/port aliases and non-64-bit CS contexts.
The single Worker owns and pins memory/context through asynchronous engine
compilation and the next synchronous C cut; this is NOT a concurrent lease proof.

One table slot is reused. Every actual successor RIP is cold-compiled through
the common C decoder/planner/emitter and admitted through the C dispatcher.
The complete independent 1,256-byte CPU and 136-byte hidden-cache observation
at instruction 86 is preserved, including stack/BSS effects. The command-line
scanner then returns false for absent `no5lvl` in `console=ttyS0 nokaslr` and
returns to the real caller. At instruction **351**, RIP **0x12e3d9b** is CPUID
with EAX = ECX = 0. The cold compiler refuses -102 without changing target or
report. No instruction skip, host CPUID substitution or interpreter is used.
An objdump of the authenticated page confirms `0f a2` at that coordinate.

## Measurements and verification

* Published native archive: unchanged **63,219,311 bytes**, SHA-256
  `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
* C VM: **16,745 bytes**, SHA-256
  `c3f2f5c6057048610b6eadefd2b55757c819a08a5e9ebed5f617d83850536d54`.
* Cold C compiler: **406,462 bytes**, SHA-256
  `e3549183544429f5f5b75174edae263c4f9054d199e503bd6f37983cd19dd0bd`.
* [Actual browser JSON](2026-10-03-startup-conditions.json): 171 admissions,
  one live slot, zero manually listed branch entries; emitted construction
  bytes 54,107, transported code bytes 704,512. VM memory 524,288 bytes, cold
  memory 1,048,576 bytes. These are diagnostic bounds, not Linux RSS/reclamation.
* One browser sample: cold C calls 7.7 ms, engine construction 20.3 ms, C
  execution 3.9 ms. These exclude fetch/startup/Worker costs and are neither
  cold-shell timing nor a controlled performance comparison. Warm modules are
  NOT reused yet; every demanded cut still copies one bounded page into the
  independent cold memory. No whole-root or CPU-frame reconstruction occurs.
* Native/cold C output: **734** byte-identical emissions including repeats.
  Full `make -C src/v2 -j2 check`, compiler and VM ASan/UBSan pass, with no
  warning/sanitizer diagnostic. Native MMU code-view checks cover non-identity
  and 2 MiB translation, NX, stale/deferred and unchanged rejected output.
  **20 actual C-Wasm export cases** additionally verify wrapper private bounds,
  compatibility rejection, A-bit aliasing, growth and no execution grant.

## Reproduce and next red

```sh
make -C src/v2 -j2 check
bash data/oracle/prepare-condition-cuts.sh temp/new-conditions
node data/oracle/check-wasm-cuts.mjs temp/new-conditions
node data/oracle/check-wasm-dispatch.mjs VM.WASM temp/new-conditions
node data/oracle/check-code-view.mjs VM.WASM
bash data/oracle/prepare-startup-cuts.sh BUNDLE.tar.zst \
  4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc temp/new-startup
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/prepare-browser-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/serve-browser.mjs --port=8080
# Open /src/v2/vm/check/browser/startup.html with ordinary browser control.
```

Native fixture preparation authenticates the archive before extraction. The
browser's local SHA fixture manifest is not signed production source admission.
Five bounded source pages and reconstructible setup/RAM are prepared; general
artifact page supply and crossing-first-instruction fetch are not connected.
Next implement common fixed-profile CPUID (not host capability passthrough),
MSR and required precise exception/device/root boundaries. Whole-image -104
and every Linux/development/storage/network product gate stay explicit.

Reference: [Intel SDM Volume 2B](https://cdrdv2-public.intel.com/868141/253667-089-sdm-vol-2b.pdf),
SETcc pages 4-613–4-615. Undefined shift flags follow the previously documented
canonical representative, not an invented exact match to unspecified hardware.
