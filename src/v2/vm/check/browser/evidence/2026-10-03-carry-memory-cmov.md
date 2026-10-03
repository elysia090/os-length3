# Common carry and memory conditional moves — 2026-10-03

The full goal remains active: the same shipped bundle in a real browser,
Linux/PID 1/offline development, authenticated bounded storage/workspace
recovery and granted virtual-NIC network/service use. Boot, shell and the
three-second cold-shell target are **not achieved**. Passing this bounded
startup diagnostic is not Linux boot.

## Input and outputs

The native bundle is unchanged: 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
Kernel/initramfs/BusyBox identities remain in the
[actual browser receipt](2026-10-03-startup-carry-memory-cmov.json).
No native artifact, human-facing UI, WSL or NixOS input changed.

* C VM, unchanged: 20,799 bytes,
  `d6b9f9a5732f90f9e1b7cfc5c9a9350a12eb1af53d598e065930a7a75dd8f6f8`.
* Final cold C compiler: 411,623 bytes,
  `4901757a6ddeb4aa07d793447c40e90576e7b3f5c3bd2eaf06fff2955dfc65cd`.
* Each compiler/provider imports only its own ordinary `machine.memory`.
  Pure carry cuts import no function. Memory-CMOV cuts call `machine.access`
  bound to C vm.wasm, never a JavaScript guest-memory function.

## Red witnesses and carry derivation

Previous actual startup stopped at `SBB eax,eax`, `19 c0`, `0x1e24306`.
The generic borrowed-code test first failed both ADD-with-carry and
SUB-with-borrow acceptance. One shared register lowering now admits
8/16/32/64-bit operands, high bytes, extended registers, immediates and aliases.
It never turns a memory/LOCK form into this pure operation.

Let `a,b` be width-masked input values and `c` the incoming CF:

```
ADC: r = (a + b + c) mod 2^w
     CF = (r < a) | (c & (r == a))
SBB: r = (a - b - c) mod 2^w
     CF = (a < b) | (c & (a == b))
AF = (a ^ b ^ r) & 0x10
ADC OF = (~(a ^ b) & (a ^ r)) >> (w - 1) & 1
SBB OF = ( (a ^ b) & (a ^ r)) >> (w - 1) & 1
```

Do not fold `c` into a truncated `b` before flag calculation: maximum `b`
would lose a carry, and OF/AF must use the original operands. The incoming
CF is captured before flag publication. Reverse liveness keeps its producer
even when a later instruction kills all outgoing flags. Only live flag
definitions are emitted; carry/result dependencies are not dead flags.

**66 ordinary post-linked ELF modules / 33,792 native observations** match
direct generated Wasm, and independently the actual C table dispatcher.
The first 128 rows include both incoming CF values for every pair of eight
width-specific boundary values; remaining rows are deterministic randomized
inputs. Immediate -1, self operands, AH, extended/narrow parent updates,
ADD -> ADC/SBB -> SETB -> XOR, CMP -> carry chains and CLC/STC are included.
Native hardware supplies outputs; the oracle is not another carry evaluator.

## Memory-CMOV ordering and actual faults

After carry lowering, actual browser startup advanced to `0x1e21078`, bytes
`48 0f 44 05 90 b3 00 00`, `CMOVE rax,[rip+0xb390]`. That borrowed-code
assertion was red before adding common memory-source conditional moves.

The ordering is `temporary = load(source)` first, then the shared condition
selects temporary or the old width-masked destination. The C memory boundary
returns a pending fault/wait before any parent, RIP or retirement write.
The condition is not used to suppress the load. A successful false 32-bit
CMOV still zeroes the parent high 32 bits; a fault does not. Address calculation
uses old registers even when the destination is the base or index.

All 16 conditions at 16/32/64 bits plus address aliases, 32-bit addresses,
SS, SIB, an extended parent and RIP-relative load pass: **54 modules /
27,648 complete CPU/RAM comparisons** through C vm.wasm. The access-double
test also passes, but is not the product backend. Ordinary source forms keep
one typed C read, no per-byte JavaScript callback. FS-base and LOCK forms
remain explicit refusals.

The native observer protects the final operand page with `PROT_NONE` and
captures the actual signal frame for **27,136 #PF comparisons**. This includes
true and false conditions and split operands; the RIP-relative source's
executable page is deliberately excluded from this data-fault experiment.
The C MMU matches native fault address/vector/error and unchanged CPU.
Hardware-added RF is excluded because C returns a *pending* fault, not an
already delivered hardware exception. No IRET/exception-entry success follows.

Primary architecture reference: [Intel Volume 2A, ADC/SBB and CMOVcc](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf).

## Actual browser and next machine boundary

The standard Browser API reopened/reloaded the diagnostic in an ordinary
non-isolated Worker and inspected the visible receipt. The proof screenshot
is `temp/browser-carry-cmov-1003.png`. Trace arrays are omitted from the saved
JSON; selected numerical values are unchanged.

Startup reaches **368,735 retired source instructions / 284,606 admissions**,
past both earlier compiler gaps. Independent 86-instruction CPU/cache and
378-instruction relocation-register checkpoints, the full 3,040,256-byte
kernel copy, 98,656-byte BSS and three scalar zero-fill returns totaling
131,104 bytes remain green. Counts remain mostly scalar zero-fill loops,
not a boot percentage or a distance-to-PID-1 estimate.

The next red is **pending #PF(2) at `0x1e21913`**, bytes `45 88 32`,
`MOV [r10],r14b`, attempting decompressor output at `0x1000000` with CR3
`0x1e41000`. The VM correctly returns current fault address/vector/error;
the port's older residency request `0x1e60000` is *not* the fault address.
Diagnostic failure reporting now separates both kinds of metadata.

The exact authenticated upstream `data/upstream/linux-7.2.7.tar.xz` was read:
`arch/x86/boot/compressed/idt_64.c` installs `boot_page_fault` in stage-2 IDT,
and `ident_map_64.c::do_boot_page_fault` accepts a non-present supervisor
fault and identity-maps its 2 MiB region. This supports the expected guest
handler path; it is not proof that all exception entry is implemented.
Next derive/test the common IDT/code/stack/flags/CR2 boundary and IRETQ with
hardware/system-oracle witnesses. Do not replace it with a JS map repair,
manually selected handler or an opcode/guest callback.

Delivery remains 47 exact HTTP 206 ranges / 3,056,640 fetched bytes and a
65,536-byte diagnostic chunk cache. 1,536 page supplies leave 1,549 resident
pages. One table slot is active; VM/cold memory are 6,815,744 / 1,048,576 bytes.
Engine reuse has 1,620 compilations / 282,986 exact-body hits and retains
64 instances / 20,360 emitted bytes. It does **not** eliminate per-cut C
construction. Cumulative 88,521,891 emitted bytes and 1,165,746,176 transported
code bytes are work, not resident memory, distribution bytes or download size.
Observed sub-timings are C construction 2,095.9 ms, engine 1,079.8 ms,
execution 232.3 ms, supply 258.9 ms. These exclude acquisition/setup/independent
assertions and are not cold-shell latency.

## Verification and reproduction

Full `make -C src/v2 -j2 check` passes. New native/cold comparisons pass
238 byte-identical emissions; previous CMOV/bit/memory-ALU fixtures pass
203. CALL/JMP regressions remain green (6,912/6,144 hardware CPU cases).
Selected compiler/lowering code-cut, carry-chain/high-byte and memory-CMOV
tools pass ASan/UBSan; linked decoder/provider archives are normal builds,
not whole-TCB sanitizer coverage.

```
# Build/oracle guest only; not the product runtime
bash data/oracle/prepare-carry-cuts.sh temp/carry-native-1003
bash data/oracle/prepare-memory-cmov-cuts.sh temp/cmov-memory-native-1003

# Windows official SDK / ordinary Wasm engine
data/oracle/wasm-tools.ps1 -Compiler -Output temp/carry-cmov-1003/compiler.wasm
node data/oracle/check-wasm-cuts.mjs temp/carry-native-1003
node data/oracle/check-wasm-dispatch.mjs temp/page-supply-1003/vm.wasm temp/carry-native-1003
node data/oracle/check-wasm-provider.mjs temp/page-supply-1003/vm.wasm temp/cmov-memory-native-1003
node data/oracle/prepare-browser-startup.mjs temp/page-supply-1003/vm.wasm temp/carry-cmov-1003/compiler.wasm temp/startup-page-supply-1003
```

The real browser receipt is distinct from Node execution. Linux boot,
production signed-root/AEAD/ECC supply, dirty eviction/recovery, devices,
network and offline development remain open. Preserve the full goal.
