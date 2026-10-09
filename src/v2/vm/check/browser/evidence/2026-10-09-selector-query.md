# Raw descriptor probe, selector SSA and one-word residual — 2026-10-09

The fixed make's entire PF_X byte inventory improves **397 ->368**:
233,087 lowerable of233,455. All29 previously missing LAR/LSL coordinates are
recovered. First remaining coordinate is DE D2 at0xb08c, a floating status
comparison alias. SIMD121/x87154/far91/other2 still use the unchanged total
publication gate. Native release, signed delivery and human UI are unchanged.

## Structural read in C, instruction meaning in independent SSA

The existing descriptor reader now has one common raw8-byte GDT/LDT probe.
The faulting segment/return/interrupt readers retain their selector-load policy;
the new typed query exposes coordinate availability separately from descriptor
Present. Null, out-of-limit and unusable-LDT coordinates are normal unavailable
results, not #GP. Real paging faults and host residency remain separate.

`machine.descriptor(private_pair_port,selector16)` returns raw descriptor and
availability. It accepts no opcode, destination register, source decoder or
full CPU image. Implicit descriptor reads use supervisor privilege and never
set the descriptor Accessed bit. The independent x86 frontend checks LAR/LSL
source widths, effects, prefixes and descriptor word; its SSA owns type/DPL/
RPL/conforming visibility and result projection.

```text
valid = available
        && (code/data || allowed_long_mode_system_type)
        && (conforming_code || (CPL <= DPL && RPL <= DPL))

LAR = (descriptor >> 32) & 0x00f0ff00
limit20 = (descriptor & 0xffff) | ((descriptor >> 32) & 0xf0000)
LSL = G ? ((limit20 << 12) | 4095) : limit20

candidate16 = (old_parent & ~0xffff) | (result & 0xffff)
candidate32/64 = zero-extended result32
new_parent = valid ? candidate : old_parent
new_ZF = valid
```

The parent select is part of the independent SSA, not a backend control branch.
A failed32-bit query preserves all64 old bits. A16-bit success preserves the
upper48 and masks the new low16; initial hardware comparisons caught and fixed
a high-word contamination bug. Other flags retain their incoming definitions;
the existing retirement owner clears RF only on success.

The long-mode system masks are0x1a04 for LAR and0x0a04 for LSL. Present is not
a query admission condition. Intel explicitly leaves LAR bits19:16 undefined;
the canonical result chooses zero there, with no authority assigned to those
bits. See [Intel's query/type/visibility contract](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)
and [destination-width clarification](https://cdrdv2-public.intel.com/851055/252046-079-sdm-change-document.pdf).
Current graph maximum36/span11 is an upper bound, not a global minimum proof.

## No source replay across a descriptor residency cut

A memory operand may itself alias a paging word changed by the later
descriptor lookup. Repeating its load after a host wait can select a different
descriptor. The existing C execution checkpoint now retains only
`selector+1` in one opaque word; zero means the operand has not been read.
The ordinal is bounded to17 bits, with the second checkpoint word unused.
No CPU snapshot, opcode stream or second execution engine is introduced.

The C dispatcher owns/revokes that residual on fresh entry, completion, fault
and cancellation. Descriptor success clears it before total SSA publication.
Exact suspend/Worker recovery must retain the existing execution frontier;
these synchronous residency tests do not claim that full product lifecycle
acceptance is complete.

The new raw reader uses the same source write-observer discipline as ordinary
memory access. A descriptor paging A/D update no longer revokes unrelated
execution bindings merely because some RAM was written. A test with the
descriptor PTE aliasing the source observed the old adapter's **STALE5 instead
of a successful resume**. The final version retains the operand, updates only
the touched source authority and resumes to the original result. Actual code
mutations still invalidate their bindings; the test never repairs guest PTEs.

## Independent observations, defined frontier and gates

The oracle runs actual instructions in an official reference-build Linux VM
using WHPX. A process installs its own LDT with `modify_ldt`, then reads the
installed descriptor bytes back through a separate kernel operation **before**
executing LAR/LSL. Expected descriptors are not reconstructed from query
results. This process-local test is not a product kernel/runtime or WSL input.

12 forms/12,288 native RAX/RFLAGS observations cover16/32/64 destinations,
register/memory operands, source upper garbage, normal/expand-down/code LDT
rows, Present/G/D combinations, RPL and null/out-of-limit failure. Other GPR/
FPU invariance is architectural. Hidden caches and table addresses are declared
mirror transport coordinates, not claimed measurements of inaccessible kernel
caches. The fresh receipts include those coordinates; the checker refuses
missing transport rather than repairing native registers or flags.

3,840 native LAR results differ in the explicitly undefined nibble. Raw receipts
remain intact; comparison projects only that documented undefined field on
successful32/64 LAR. Every defined bit,16-bit upper region, failed parent and
flag is checked. Do not call this full raw-bit equality or pretend that CPL0/
system descriptor tests were physically measured by this CPL3 LDT oracle.

The independent SSA exhausts98,304 type/S/Present/G/CPL/DPL/RPL/availability/
parent-width models.6,528 source/address/register constructions and104,448
malformed laws pass.199 C owner assertions cover GDT/LDT, implicit supervisor
read, no Accessed write, stale generation, private extents, guest page faults,
residency and unchanged state. Guest P=0, not an untrusted host cache-fault row,
is the page-fault authority.

1,442 actual compiled C-MMU/table boundary comparisons pass:264 faults,
264 ordinary waits,912 immediate successes and266 complete-state retries.
The two additional comparisons exercise source/descriptor A/D alias explicitly.
Readonly and cross-page source/descriptor extents are included; user source
faults have U/S set while implicit descriptor faults do not. The old LLDT/LTR
negative fixture is updated to test LAR/LSL's distinct positive query path;
malformed query refusal remains independently enforced.

Full VM checks, scoped compiler/postlink and positive ASan/UBSan are
warning-free;464 postlink semantic witnesses remain green. The separately
retained unrestricted native CALL RAM-payload red is not relabeled solved.
The same-bundle bounded startup retains86-cut/1,617,931-retirement witnesses,
not PID1/offline shell/cold3s/RSS. Modern image/startup import registries use the
actual C descriptor/checkpoint exports; native publication/UI are unchanged.

Compiler746,232 bytes, SHA256
`7eb5433875d88b46eae8e5bde4bc18e85948e3a91350a9fc8ac85987ac331de1`.
ABI4 VM99,927 bytes, SHA256
`13b086ab7769d7c71ae15e63d7839be5bf4df6a0f9f30393f0928e62815da640`.

```sh
make -C src/v2/x86 all
make -C src/v2/vm all check
make -C src/v2/wasm-compiler all selector-query-check system-segments-check
LINUX-SELECTOR-OBSERVER NEW-HARDWARE-DIRECTORY
node data/oracle/check-selector-query.mjs VM.WASM COMPILER.WASM NEW-HARDWARE-DIRECTORY
node data/oracle/check-selector-query-boundary.mjs VM.WASM COMPILER.WASM
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Continue the common floating aliases/arithmetic and far call/jump closure,
then publish and verify the full browser development objective.
