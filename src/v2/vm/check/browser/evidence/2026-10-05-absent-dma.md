# Explicit legacy-DMA absence — 2026-10-05

The [completed same-bundle run](2026-10-05-node-startup-binding-io-red.json)
stops at `0xffffffff81405c2b`, `e4 87` (`IN AL, 87h`), result 6 and zero
retirement. Decoding/emission already work; C has no bus target definition.
Retained fault/request fields do not establish a new #GP/clock event here.

## Machine contract before the branch

The locked `data/upstream/linux-7.2.7.tar.xz` was read directly:
`arch/x86/kernel/i8237.c`, `i8237A_init_ops`, reads page port 87h and returns
`-ENODEV` on ffh. Its removed-device contract covers 81h-83h, 87h, 89h-8Bh
and 8Fh. The [upstream source](https://github.com/torvalds/linux/blob/master/arch/x86/kernel/i8237.c)
documents this absence on newer PCH systems. The
[ISA DMA interface](https://www.kernel.org/doc/html/latest/core-api/dma-isa-lpc.html)
is optional and distinct from general memory/bus-master DMA. This VM does not
claim to emulate that PCH, a BIOS, or an 8237 engine.

The direct-entry platform has no ISA DMA controller/client, floppy, ISA sound
card or parallel-port DMA. Virtual block/network devices do not require it.
Define these eight removed ports explicitly: byte reads float high, byte
writes discard data, with no writable register/DREQ/IRQ/RAM/clock state.
No existing DMA device is removed. This extends the fixed platform contract,
not a default invented for all unknown I/O.

```text
S = {81h, 82h, 83h, 87h, 89h, 8Ah, 8Bh, 8Fh}
absent(p) = (p & ~15) == 80h && ((8E8Eh >> (p & 15)) & 1)
read8(p) = ffh                           if p in S
write8(p, x): device' = device           if p in S
```

No eight-slot materialization is needed. The existing C provider checks mode,
generation and x86 CPL/IOPL/TSS permissions before this bus response. Pending
clock/console replies cannot be consumed. Unknown ports and unsupported
16/32-bit transfers still refuse; permission and source-fetch faults retain
priority. Only the read result is published; the normal generated instruction
updates AL/RIP/RF/retirement. Linux takes its ordinary absence branch. No
instruction/initcall is skipped, and no interpreter is added.

## Red to green and scope

Before implementation the new native I/O matrix has 6,000 failed assertions.
The generated-cut test independently fails with actual 6 / expected 1 on
its first valid byte read. After the change:

* Native C: 12,288 absent-device transfers plus the unchanged 7,680 permission
  cases, TSS crossing-page residency/#PF, TF, generation, pending clock/console
  and unknown-neighbor checks pass.
* [C-Wasm check](2026-10-05-absent-dma.json): 209 emissions, 6,145 complete-CPU
  comparisons, 1,665 retirements, 1,152 permission faults, 3,328 width refusals.
  Source #PF/stale generation/wrong binding/pending clock each pass 192 cases;
  unknown neighbors pass 16. Immediate/DX, IN/OUT, address prefixes, all widths,
  CPL/IOPL pairs, memory growth and the exact stopped coordinate are tested.
* Fresh native-C I/O/RDTSC emissions: 26 exact cold/native parity cases and
  3,328 C-Wasm permission/event comparisons pass.
* Full VM C check, scoped I/O ASan/UBSan and the admitted-coordinate C-MMU
  regression pass. These builds have no compiler warnings.

These are explicit platform/frontier models, not physical-CPU or QEMU
system-mode I/O comparisons, browser acceptance, PID 1 or Linux boot.
VM: 63,165 bytes (+80), SHA-256
`954db4314a758d7b0705118fb250d2dc82be3699aa3021a7c81f451cbe8329ac`.
Compiler unchanged: 446,940 bytes, SHA-256
`ca7788b12f97b52cf3c44d13923d7edc66217c7c6a69141f5ad357496c7bd245`.
Native bundle/UI/retained browser Workers/staged binaries are unchanged.

```sh
make -C src/v2/vm check
node data/oracle/check-absent-dma.mjs VM.WASM COMPILER.WASM
node data/oracle/check-io.mjs VM.WASM COMPILER.WASM FRESH-NATIVE-IO-DIR
node data/oracle/check-entry-binding.mjs VM.WASM COMPILER.WASM
```
