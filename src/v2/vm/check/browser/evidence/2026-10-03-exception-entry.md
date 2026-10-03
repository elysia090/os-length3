# Common long-mode fault entry and IRETQ — 2026-10-03

The full browser product goal remains active. Linux/PID 1/shell, offline
development, authenticated workspace/storage and granted network/service use
are **not achieved**. A bounded startup diagnostic is not Linux boot.

## Fixed input and actual browser

The published native bundle is unchanged: 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`,
rechecked after this implementation. No native artifact or human UI changed.
The [visible browser receipt](2026-10-03-startup-exception-entry.json) records
the same kernel/initramfs/BusyBox inputs. Trace arrays alone are omitted.

The previous red was #PF(2), address `0x1000000`, at `0x1e21913`, bytes
`45 88 32`. C now reads the guest IDT and enters its `0x1e25cc0` handler.
The guest Linux handler constructs its own mapping and returns through cold
compiled IRETQ. The browser resumes decompression, reaching **1,616,430 source
instructions / 1,000,000 admissions**. R10 advances to `0x10c24d8`; this is
actual output progress, not the same fault replayed or an init percentage.
The stop is an explicit diagnostic quota (1,000,000 admissions / 2,000,000
retirements), not a compiler fallback, unsupported-coordinate repair or boot.

Independent 86-instruction CPU/cache and 378-instruction relocation checkpoints,
the full 3,040,256-byte copy, 98,656-byte BSS and three scalar memset returns
totaling 131,104 bytes remain green. Actual standard Browser API inspection
used an ordinary non-isolated Worker. Proof: `temp/browser-exception-1003.png`.

VM: 25,244 bytes, SHA-256
`a9d28cb6264fd1814b646460ccce528aa9c96832e898088b4c4b1792e1cbc5ea`.
Cold C compiler: 412,293 bytes, SHA-256
`f784134a0618c3b72d650fba788e4702304754abdab62e495462a0cbe29e4355`.
Each imports only ordinary machine memory. Emitted IRETQ imports `machine.iret`,
bound directly to the C VM, not JavaScript exception semantics.

## Derivation and bounded continuation

The authenticated upstream `data/upstream/linux-7.2.7.tar.xz` was read directly:
`arch/x86/boot/compressed/idt_64.c`, `ident_map_64.c` and
`idt_handlers_64.S`. Linux installs the stage-2 trap gate, reads CR2, maps a
non-present 2 MiB identity range, saves/restores GPRs and removes the error
word before IRETQ. Neither the compiler nor host hardcodes that target or
patches guest page tables.

For the admitted CPL0 -> CPL0 64-bit, IST=0 fault contract:

```
aligned_rsp = old_rsp & ~15
push order  = SS, old_rsp, saved_flags | RF, CS, fault_rip, [error]
handler_rsp = aligned_rsp - 8 * (5 + has_error)
handler_rf/tf/nt/vm = 0
handler_if = old_if for trap gate, 0 for interrupt gate
CR2 = fault_address for #PF
IRETQ       = pop RIP, CS, flags, RSP, SS
```

Gate, code descriptor, canonical coordinates and frame stores use the same C
MMU. Missing *physical residence* retains one 160-byte event frontier; it is
not a full CPU snapshot. Completed stores can alias the IDT/GDT/paging records,
so retry must not reread a gate already consumed or repeat a completed store.
The owner pins all CPU/segment state and rejects guest writers during delivery.
CR2 is published before #PF entry. No faulting instruction retires on entry.
RF restored by IRETQ is cleared only by the next successful ordinary retirement;
pending faults/residency waits leave it intact.

Primary architecture sources: [Intel Volume 3A, sections 6.14.2–6.14.3](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-3a-part-1-manual.pdf),
[Intel Volume 2A, IRET](https://cdrdv2-public.intel.com/819712/253666-sdm-vol-2a.pdf).

## Red-to-green verification and limits

The common borrowed-code check rejects IRETQ before this lowering and accepts
it now; IRETD/IRET16/LOCK remain explicit refusals. A real system-mode fixture
enters long mode, installs its own GDT/IDT and triggers #PF/#UD/#GP under 16 RSP
alignments, two gate types and two flag inputs. **96 QEMU TCG system-oracle
frames** match both native C and actual C-Wasm for frame/flags/CR2. All 96
generated IRETQ returns and their following generated NOP RF-clears pass.
QEMU here is an oracle, not the product runtime or physical-hardware evidence.
The fixture additionally records INT3, but the 32 trap cases are deliberately
excluded from this fault-entry acceptance.

Native tests cover stale generation, absent IDT gate (#NP), unsupported IST,
noncanonical aligned stack (#SS), missing IDT/stack residence, and a frame
store that overwrites its own gate before a cross-page wait. Append/resume
must use the latched gate and completed-write frontier. Full product `make
-C src/v2 -j2 check` passes. All linked C VM core plus exception tests pass
ASan/UBSan; that is not whole compiler/decoder TCB sanitizer coverage.
Freshly emitted control reads (5,280), writes (23,360), CPUID (7,504), carry
dispatch (33,792), memory CMOV CPU/RAM (27,648) and actual pending protection
faults (27,136) remain green after RF retirement semantics changed.

This is **not** complete exception architecture. TSS/IST, privilege changes,
compatibility/CET, #DF/triple-fault escalation, IRQ/NMI/debug delivery remain
open. Secondary architectural delivery faults stop explicitly. No recursive
host repair pretends they succeeded. IRET fault-priority coverage also needs
expansion beyond these positive system frames and current negative fixtures.

## Measured next dominant fixed cost

47 HTTP 206 reads / 3,056,640 fetched bytes, 65,536-byte diagnostic chunk cache,
1,549 resident pages, 6,815,744 VM memory and 1 MiB cold memory are unchanged.
But 1,000,000 demanded admissions accumulate **4,096,000,000 copied code bytes**
and 338,352,494 emitted bytes. These are repeated work, not resident RAM,
download bytes or artifact growth. Bounded engine reuse has 1,957 compilations,
998,043 hits and 64 retained instances / 21,650 emitted bytes; it still invokes
the C compiler on every cut.

Observed sub-timings: C construction 7,905.1 ms, engine 3,560.5 ms, execution
555.2 ms, supply 170.1 ms. Setup/acquisition/independent checks are excluded;
these are not cold-shell latency or a repeatable benchmark. Next eliminate
repeated page transfer/construction with C-owned source admission and exact
source/lifetime/code-alias checks, then continue decompression and machine
coverage. Do not replace semantic validation with a JavaScript source cache.

## Reproduce

```sh
# Build/oracle environment only
make -C src/v2 -j2 check
bash data/oracle/prepare-exception.sh temp/exception-entry-1003

# System oracle; expect isa-debug-exit status 33, not ordinary status 0
qemu-system-x86_64 -accel tcg -m 64 -smp 1 -net none \
  -kernel temp/exception-entry-1003/entry.elf -display none -serial none \
  -monitor none -no-reboot -debugcon file:temp/exception-entry-1003/frames.txt \
  -device isa-debug-exit,iobase=0xf4,iosize=4

# Official Windows SDK builds and ordinary Wasm engine
data/oracle/wasm-tools.ps1 -Output temp/exception-entry-1003/vm.wasm
data/oracle/wasm-tools.ps1 -Compiler -Output temp/exception-entry-1003/compiler.wasm
node data/oracle/check-exception.mjs temp/exception-entry-1003/vm.wasm temp/exception-entry-1003/compiler.wasm temp/exception-entry-1003/frames.txt
node data/oracle/prepare-browser-startup.mjs temp/exception-entry-1003/vm.wasm temp/exception-entry-1003/compiler.wasm temp/startup-page-supply-1003
```

Open `/src/v2/vm/check/browser/startup.html` on the scoped local diagnostic
server and inspect its receipt. Local SHA-256 checks are not production
signed-root/AEAD/ECC admission. Boot/shell/dirty recovery/storage/network and
the three-second goal remain open.
