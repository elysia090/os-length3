# Shared memory shift/rotate SSA — 2026-10-04

## Red boundary and derivation

The preceding actual browser refused `sarq %cl,16(%rsp)` (`48 d3 6c 24 10`)
at `0xffffffff81086ff7`. A fresh native fixture first reproduced grammar
/-102 for memory ROL; register shift/rotate was already implemented.
This was common operand admission, not a missing Linux-specific function.

For width `w` in {8,16,32,64}, the ordered lowering is:

```text
address = EA(old registers, address size)
count = low8(CL or immediate or 1) & (w == 64 ? 63 : 31)
old = reserve_read_write(address, w/8, segment)
value, flags = existing_shift_rotate_SSA(old, count, old_flags, w)
commit(value)
RFLAGS = flags; RIP = fallthrough; retired += 1
```

Effective address and masked count are captured before reservation. The
same pure value/flag emitter serves register and memory operands, without
an opcode crossing into the VM, an interpreter, a CPU snapshot or a payload
image. A failed reservation or commit returns before CPU publication.
Page-table A/D updates remain architectural side effects of translation.
All fragment permissions are checked before any scalar payload store.

A masked-zero count preserves the operand and every flag, but does not skip
memory access. Independent x86 observations include 6,740 masked-zero write
#PF frames. Keeping the ordinary RMW contract preserves those faults and
residency waits. Narrow rotations use the existing repeated-word expression;
count mask and modulo-width value rotation remain distinct. Undefined
AF/CF/OF are compared only through the definedness mask, with zero separately
checked as the compiler's chosen representative.

## Verification

The reference QEMU TCG build VM executes real x86 user-mode instructions and
captures signal frames through the assembly trampoline. It is only an
independent oracle, not the product route or a physical-hardware proof.
All 174,080 pre-lowering observe-only records agree with the later native
records through the declared flags-definedness mask; arbitrary undefined
flag representatives can differ between runs and are not rewritten.
340 forms cover five operations, four operand widths, all 256 CL values,
implicit one and 11 immediate counts, 32/64-bit addresses, old-RSP and
scaled RCX/address aliases, extended GPRs and RIP-relative self-code writes.
174,080 native complete CPU/RAM observations include 34,240 fault frames:
split accesses, read/write protection, missing pages and noncanonical DS/SS.
Both RAM mappings and the full local code payload are checked for unexpected
stores, including on faults.

Every native-C and cold-C emitted module is byte-identical. Actual C-Wasm
reserve/commit callbacks give 174,080 direct and 174,080 C-dispatch full
CPU/payload comparisons plus 174,080 RF checks. Separate models give 1,700
entry refusals, 1,360 waits/retries and 20 executable-write revocations.
Waits promote the exact deferred physical descriptor through the serialized
test owner, not guest-PTE repair or signed production supply. Retry retires
once; stale execution cannot run again after an executable write. These
checks do not establish exception-frame delivery, SMP or MMIO replay.

340 pure-predecessor cut frontiers and 20 LOCK/FS/GS/RCL/RCR refusals pass.
Refusal preserves output bytes, output length and report. Old negative
code-cut tests are updated to reject through-carry register **and** memory
forms, rather than incorrectly requiring ordinary memory rotates to fail.
RCL/RCR are not claimed as supported.

266 register modules remain byte-identical before/after the shared-emitter
refactor. Regenerated SHL/SHR/SAR gives 156 modules / 79,872 direct and
79,872 C-dispatch comparisons; ROL/ROR gives 110 / 56,320 / 56,320.
The C source-admission regression and full `make -C src/v2 check` pass.
The complete lowering library's scoped code-cut ASan/UBSan check passes;
linked decoder/proof/support archives in that run are ordinary builds.
The C VM is unchanged from the preceding checkpoint, not a newly sanitized
VM binary in this turn.

```sh
make -C src/v2/wasm-compiler memory-shift-check
src/v2/wasm-compiler/build/memory-shift-check FRESH-NATIVE-DIRECTORY
node data/oracle/check-memory-shift.mjs VM.WASM COMPILER.WASM FRESH-NATIVE-DIRECTORY
# Optional fourth argument compares fresh native observations before lowering.
node data/oracle/check-memory-shift.mjs VM.WASM COMPILER.WASM FRESH-NATIVE-DIRECTORY OBSERVE-ONLY-DIRECTORY
make -C src/v2 check
```

```text
VM       60,752 bytes SHA256 630991f1652712b33402b2521c85b77799c703f9a7b1f09d1707322dbcaa83ac
compiler 435,019 bytes SHA256 4376bc6fa6f10dbef820135d4a3e783a5d01b8afd85cbfbcd0d6379f42e7de09
bundle SHA256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

The compiler grows 171 bytes over memory PUSH. No VM opcode handler, native
bundle modification or human UI change is added. Browser acceptance is
recorded separately after reloading the staged candidate; component passes
above are not Linux/PID 1/shell acceptance. The full goal and cold shell
three seconds remain unachieved.

## Host engine lifetime and diagnostics

The first browser run used the previously loaded FIFO engine cache. Its
intermediate observation at 140,000,006 retired / 71,426,126 admissions
showed engine 132,019.1 ms, cold emission 34,035.0, execution 39,327.5,
admission 23,927.0 and supply 198.9. That running observation is not a
completed SAR acceptance or a cold-shell time. It was preserved before
reloading the candidate, not relabeled as a final receipt.

The hot/cold component test first failed when an exactly repeated hot body
was evicted by inactive cold bodies. Exact-byte hits now refresh demand
lifetime through bounded Map insertion order. Both entry-quota and byte-quota
models give 33 constructions and 32 hits for one hot body plus 32 cold
bodies, retaining the same hot instance. All existing changed-body,
caller-arena reuse, invalid-emission, grow, table-placement, independent-owner,
pending-close and quota tests pass. No quota increase, guest opcode cache,
source acceptance bypass, new index or sort is introduced. Engine internal
RSS is still not bounded by the emitted-witness byte quota. This component
result is not asserted as a browser speedup.

The extended diagnostic previously reported only each ten million retired
instructions. It now reports each million retirements **or** admissions,
and each 256 repeat quantum yields, including the architectural RCX and
current engine counts. These are read-only observations, not guest-state
snapshots, instruction counter changes or altered execution quotas. The
same staged compiler/kernel is reloaded normally to verify this candidate.

## Actual browser acceptance and next common gate

After normal reload, the ordinary-memory Worker completes the extended
diagnostic with the staged compiler above and unchanged C VM. The
[raw visible result](2026-10-04-memory-shift-browser.json) is saved without
changing the source instructions, kernel, counters or acceptance quotas.
Its trace shows memory SAR retiring at `0xffffffff81086ff7`, followed by
the real Linux code through `0xffffffff8108700f`.

The next common grammar refusal is -102 at:

```asm
# 0xffffffff8108700f: 49 0f ac d3 20
shrdq $32, %rdx, %r11
```

SHRD/SHLD have not yet been implemented by this checkpoint. The next fix
requires a shared general lowering and independent native register/memory
fixtures, not a special case for this kernel coordinate.

The actual result contains 144,564,477 retired source instructions,
74,868,147 admissions, 5,717 console bytes and 3,422 external IRQs. Linux
reports `VFS: Finished mounting rootfs on nullfs`; this is early guest
VFS/rootfs initialization, **not** a mounted release filesystem, PID 1 or
an offline shell. The complete 14,622,864-byte decompressed image (3,571
pages) still matches SHA256
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
`status: pass` describes diagnostic checks only; `linuxBoot: not-achieved`
remains explicit. Retirement counts vary with calibration, not a boot
percentage or an equal-work performance comparison.

The measured phases, in milliseconds, are engine construction 373,684.7,
cold C emission 73,707.8, C execution 51,371.4, C admission 27,855.5 and
physical supply 201.1. Construction remains the largest measured cost:
4,148,301 constructions and 2,363,249 exact-byte hits. The bounded cache
ends at 752 entries / 261,836 witness bytes (same maxima: 1,024 / 262,144).
The LRU component correction is not relabeled as a browser speedup. Separate
absent/evicted-body misses from changed-emission misses before deciding the
next physical-identity/lifetime optimization.

C VM memory is 19,398,656 bytes with 4,527 resident pages; compiler memory
is 1,048,576 bytes. Copied source bytes total 26,732,261,376 cumulatively,
not simultaneous RSS. Supply uses 49 fetches / 3,154,432 fetched bytes /
3,046,912 requested bytes, with a 65,536-byte transport-cache high-water.
This diagnostic checks local SHA256, not signed production admission;
authenticated release/root/workspace delivery remains a goal requirement.
No native bundle or human UI bytes are changed. Cold shell three seconds,
PID 1, offline development and granted network/storage acceptance remain red.
