# Ordered memory-source PUSH — 2026-10-04

## Derivation

The previous actual browser reached Linux's vector-3 entry and refused
`pushq 40(%rsp)` (`ff 74 24 28`) at `0xffffffff810009ad`. The common compiler
supported register/immediate PUSH and memory-destination POP, but did not
admit memory-source PUSH. A fresh native fixture first reproduced grammar
/-102, before changing the lowering. This is an ISA admission gap, not a
missing Linux function or a reason to add an interpreter.

For operand width `w` in {16,64}, the necessary ordered equations are:

```text
bytes = w / 8
source = EA(old registers, explicit address-size)
value = read(source, bytes, explicit segment)
destination = old RSP - bytes       // always 64-bit stack address
write(destination, bytes, value, SS)
RSP = destination; RIP = fallthrough; retired += 1
```

The source observes old RSP, including when it aliases the new stack word;
see [Intel SDM, PUSH](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf).
Source read faults precede stack-write faults. Local SSA retains the destination
and source scalar, not a CPU snapshot, stack image or materialized block.
The two calls use the existing typed `machine.access` C MMU. A transfer is
not an RMW reservation: module selection now classifies PUSH alongside
CALL/POP as an ordered transfer. No opcode crosses the memory boundary.

CPU/retirement publication follows both accesses. A scalar all-fragment
write preflights every translation before any payload store. Thus fault or
residency wait leaves CPU/payload unchanged, although architectural page-table
A/D updates can occur. In the current serialized model, a retry can reread
ordinary RAM because no other guest writer/event/remap intervenes. This is
not SMP/LOCK atomicity, MMIO replay, FS/GS or debug/alignment-check support.
These unaccepted contracts remain explicit refusals.

## Independent observations and models

The reference QEMU TCG build VM executes real x86 user-mode code through
the existing assembly trampoline and captures signal ucontext frames. It is
an independent reference, not the product path or physical-CPU proof.
28 forms cover 16/64-bit operands, 32/64-bit explicit addresses, old-RSP
source, displacement 40, GPR/RBP, scaled extended-register SIB, RIP/EIP
relative source and explicit DS/SS overrides. 3,584 complete CPU/RAM
observations include 1,648 fault frames: read/write protection, missing page,
split source/store, competing source/stack fault, noncanonical addresses,
truncated high source with a still-high stack and overlapping source/store.
Untouched bytes across all three RAM regions are also compared.

Every native-C and cold-C emission is byte-identical. Actual C-Wasm MMU
callbacks give 3,584 C-dispatch and 3,584 direct complete CPU/payload
comparisons, another 3,584 RF checks and 140 entry refusals. Separate
architectural models check 168 residency waits plus 168 retries, and
18 physical stack/executable aliases. Waits promote the exact deferred
physical descriptor through the serialized test owner, not a repaired guest
PTE or signed production supply route. Each wait preserves CPU and payload;
success retires once. An executable alias write revokes the current
admission; a second dispatch cannot execute the stale row.

Preceding pure instructions are a separate cut. LOCK/FS/GS refusal leaves
output, written length and report unchanged. All product checks and scoped
compiler ASan/UBSan pass; the linked decoder/proof/support archives in that
scope are ordinary builds. The C VM binary is unchanged from the preceding
software-interrupt checkpoint, whose linked VM core sanitizer checks pass.

Old POP/LEAVE fixture modules were generated before the current entry/debug
guards, so their byte-parity check correctly refused the old bytes. New
independent observations and native emissions were regenerated, not patched:
POP gives 24 identical modules / 6,144 direct and 6,144 dispatch CPU/RAM
comparisons, CALL 27 modules / 6,912 CPU/stack comparisons including 448
retained stores on target #GP, LEAVE six modules / 1,536 direct and 1,536
dispatch comparisons. Existing software trap/frame checks stay green.

```sh
make -C src/v2/wasm-compiler push-memory-check
# Exclusive-write fixture output requires an existing fresh empty directory.
src/v2/wasm-compiler/build/push-memory-check NATIVE-DIRECTORY
node data/oracle/check-push-memory.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY
make -C src/v2 check
```

## Browser acceptance

The [actual browser receipt](2026-10-04-push-memory-browser.json) follows
ordinary fixture staging and a page reload. The same shipped kernel passes
the old PUSH boundary and logs `pid_max`, mount caches and
`VFS: Finished mounting rootfs on nullfs`. This is early guest VFS/rootfs
initialization, not an attached release filesystem or PID 1/shell success.
The next common grammar refusal is `sarq %cl, 16(%rsp)` (`48 d3 6c 24 10`)
at `0xffffffff81086ff7`. 144,754,379 instructions are retired through
75,002,351 admissions and 4,264,936 engine compilations. Linux UART gives
5,717 bytes. The kernel's full decompressed output remains SHA-identical.
Counts depend on calibration and are not progress percentages or speedups.

```text
VM       60,752 bytes SHA256 630991f1652712b33402b2521c85b77799c703f9a7b1f09d1707322dbcaa83ac
compiler 434,848 bytes SHA256 0953020314487d71276c410bd4951389a3cacc36dc105c3beb0cc1ab8dde54a3
bundle SHA256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

The compiler grows 108 bytes over the software-trap checkpoint; no VM opcode
handler is added. Engine construction dominates at 379,742.1 ms, cold
emission 77,025.5, C execution 51,650.9, admission 27,840.4 and supply 209.2.
Source copying is 27,130,769,408 cumulative bytes; the 752 retained witnesses
hold 261,985 bytes, not an engine RSS bound. VM memory is 19,398,656 bytes
with 4,527 resident pages, compiler memory 1,048,576. Transport remains
49 fetches / 3,154,432 fetched / 3,046,912 requested bytes, with
65,536-byte cache high-water. These are diagnostic phase sums, not cold-shell
time. Native bundle and
human UI remain unchanged. PID 1/tooling/storage/network and cold shell
three seconds remain unachieved. Source copying is cumulative, not RSS;
bounded byte witnesses do not bound engine memory. Ordinary non-isolated
Worker and diagnostic SHA integrity are tested, not signed production
admission or physical-memory reclamation.
