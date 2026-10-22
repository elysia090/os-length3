# Exact scalar binding instead of per-displacement bodies — 2026-10-05

## Actual maximum term and red

The frozen warm-64 run from `2f94b2d` completed at its unchanged admission
quota: 150,000,000 host admissions / 255,274,658 retired x86 instructions,
RIP `0xffffffff8109b342`. Its 91,496,390 warm completions demonstrate actual
post-Linux-entry activation, not a short-prefix assumption. No unsupported
instruction is the terminal gate. PID 1, release-root mount and shell are
still unachieved. Cold shell 3s is unmet. This is independent Node evidence,
not browser acceptance.

Engine construction remains largest: 57,114,117 constructions / 1,623,498 ms,
C cold emission 705,074 ms, execution 276,196 ms, admission 43,587 ms and
extent supply 833 ms. Total 2,936,145 ms. Engine witnesses remain bounded to
754 entries / 262,015 bytes; source metadata is 6,880 bytes with no payload
copy. Allocated linear Memory is 22,085,632 bytes, not RSS. Different clock
calibration and retired work prevent an elapsed-time speedup comparison.
See the complete receipt.

The immutable release bzImage decompresses to the same optimized ELF SHA-256
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
The first executable PT_LOAD begins at file offset `0x200000`, virtual
`0xffffffff81000000`. Disassembling that exact ELF shows six hot RAX loads
at `0xffffffff810a7f5d + 14*i`, and six RAX stores at
`0xffffffff810a7f64 + 14*i`. They differ in signed RIP displacement.
This is matched static provenance, not an assumption that runtime
alternatives cannot modify their bytes; execution still requires C admission.

The existing C compiler emits twelve distinct exact bodies for those twelve
instructions. Their witnesses occupy 4,122 bytes. The old entry-coordinate
binding alone does not remove this displacement term. The
red is reproduced with frozen ABI-2
VM/compiler binaries. No body is byte-patched or executed in that diagnostic.

## Derivation and enforced scope

For an isolated explicit IP-relative memory operand, let `E` be the admitted
instruction entry, `L` its unchanged length and `d` its decoded signed disp32.
The architectural effective address is exactly

    address = truncate_address_width(E + L + sign_extend_32(d))

Substitute `E` and `d` by immutable scalar arguments; leave operation, width,
GPR/vector bindings, immediate values, transaction ordering, flags and length
in the compiled topology. There is then no reason to store another executable
body merely because `d` changes. Sign extension occurs BEFORE address32
truncation. Loaded targets and literal guest pointers are not rebound.

The compiler only admits this substitution for a one-instruction boundary
with exactly one eligible explicit IP-relative operand, no GPR index,
address width 32/64, and a displacement representable as signed 32 bits.
Zero displacement uses the same body as nonzero displacement. Pure
multi-instruction slices and unrelated immediates retain their exact values.
The generated body imports no source reader or decoder.

The uniform machine-entry ABI is now 3:

    cut(i32 state, i32 port, i64 admitted_entry, i32 operand_binding) -> i64

The final report word at byte 76 replaces its old tail padding; sizeof report
remains 80. The final row word at byte 20 replaces its old reserved field;
sizeof row remains 24. `vm_sources_publish` receives the trusted cold report's
binding and keeps it in the original source-owned row. `vm_bind_execution`
compares it with that owner before lending a row. Every C table call passes
the selected entry and displacement by value. The existing continuation copies
that same row, so descriptor changes, code self-writes and memory growth cannot
rebind an in-flight instruction. There is no new descriptor array or scalar
source payload, and source metadata remains 6,880 bytes / 64 rows.

Sufficient conditions are: the compiler's exact decode attestation; immutable
entry/displacement bindings throughout the cut and any continuation; and the
existing fresh C-MMU/source-generation/context/event admission at every new
cut. Sharing exact bodies supplies none of these permissions. An equal-value
physical source write still revokes the source. A mismatched owned row refuses.
Old two- and three-argument table types trap before their observable store;
there is no compatibility execution adapter.

This proves parameterized body sharing for the stated normal form, NOT global
equivalence of guest states or completeness/minimality of the whole ISA.
General GPR-relative displacement, arbitrary literals and multiple independent
operand values are not silently generalized by this patch.

## Validation and counted cost

The same release coordinates now have two exact bodies, 348/337 bytes:
4,122 -> 685 witness bytes (83.38% reduction for this twelve-instruction set).
The unchanged bounded owner receives 4,096 requests and constructs 12 -> 2
instances, with zero eviction in both controlled samples. Timings are recorded
but not promoted to Linux/browser speedup. See
green and constructor scope.

The final ABI-3 binaries are:

* compiler: 447,154 bytes, SHA-256
  `f148b656eca2538a8ce99195563cdb2a088a361de39b9d72eac5c566fc88d4b1`
  (214 bytes above the previous compiler);
* VM: 67,128 bytes, SHA-256
  `f0cdd887dcc403faf3ce245b6095b8bfcba110d51228c10a1b6c24f68e4b17e9`
  (22 bytes above the disjoint-write candidate).

The new product code cost is counted; no claim that the entire distribution
shrinks by the fixture ratio is made. Native bundle bytes and human UI are
unchanged. Retained browser Workers/staged Wasm assets are not replaced.

Validation:

* 565 actual cold emissions, 150 complete
  CPU/physical-memory observations across five families / three coordinates /
  ten signed displacements, including zero, extrema, EIP truncation and
  overlapping source/data; 150 fetch faults, 115 data #PF frontiers, 150 wrong
  owned-binding refusals and 150 equal-source-write revocations. The bounded
  engine constructs only five exact bodies / 1,739 witness bytes.
* 79 native postlinked x86 modules / 40,448 C-Wasm/native observations,
  2,048 actual protection-fault comparisons, 42,496 RF checks,
  158 residency waits/retries and 768 readable-write faults. All 79 native
  emitted bodies AND scalar attestations exactly match the independent
  cold-Wasm C compiler. The recipe is `prepare-operand-cuts.sh` with an
  explicit fresh compiler build, followed by `check-wasm-provider.mjs` and
  `check-operand-binding.mjs`. Tests are not mixed into the release artifact.
* Full fresh native `vm check` and `wasm-compiler check`, including CLI rollback
  and explicit non-closure, pass. Scoped ASan/UBSan source/execution checks pass.
  65,536 C source-binding values retain exact copied/borrowed values and revoke
  after writes; 100,000 C dispatch values forward without reinterpretation.
  The continuation retains its original nonzero operand after row mutation.
* Existing coordinate/divide/fetch/continuation models,
  both old table-type refusals, source admission (536 emissions / 512 cold and
  512 hot CPU comparisons), warm/disjoint/PTE cohort models,
  IRQ/shadow priority and absent UART/DMA regressions pass.
* The same-bundle short prefix has the
  unchanged 1,617,931 retirements / 1,000,000 host admissions and architectural
  stop. There are 876 engine constructions / 115 evictions, compared with
  the previous disjoint candidate's 905 / 143. This prefix is BEFORE Linux
  entry and has ZERO warm runs. It is not a Linux warm-speedup or PID 1 proof.

## Cross-page continuation gate found during the entry-ABI sweep

The fresh ABI-3 table fixture exposed an independent product red: after a
descriptor store commits its limit and waits for the base's physical page,
`vm_run` and `pending_boundary` rejected the retained table frontier, including
its legitimate latched continuation. The same test returns `6`, not expected
`5`, with the 67,128-byte VM; expectations and native receipts were not weakened.

Only the saved compiled entry may resume this frontier. Fresh source binding,
other guest operations, generation mismatch, invalid quantum and events remain
fenced. The C execution owner already retains entry / slot / operand by value;
the fix uses that owner instead of fetching or reconstructing an instruction.
An unlatched partial store still refuses the dispatcher and event boundary.

The corrected VM is 67,133 bytes, SHA-256
`e6edc2bf393d55fb4d84c595db63d4b427f2446fc3774cce4b8d1ec5e6775cc7`.
The compiler is unchanged at 447,154 bytes. Source rows/report/metadata remain
24 / 80 / 6,880 bytes; the native release and human UI are unchanged.

Red/green receipt and complete regression results:
96 native/cold byte-identical table bodies, 16,128 explicit context/fault models,
108 independent native payload/fault comparisons, 216 waits/retries, 108 pinned
abort checks and 36 unlatched fences pass. The retry test makes the completed
limit page read-only and mutates row entry/slot/operand before resumption; replay
or retargeting therefore fails. Stale-generation and invalid-quantum refusal
preserve the CPU, prepared supply ticket and frontier.

Fresh native PUSH/POP, ordinary CALL/JMP, FXSAVE, vector/scalar-vector bodies
and comparisons pass through the corrected C VM. The system-segment fixture
now supplies the required segment-context version 2 rather than stale version
1: 144 exact bodies / 153,360 models / 3,024 QEMU TCG trace comparisons pass;
48 known oracle differences remain explicit. Scalar attestations are transported
from each successful cold receipt; saved fixtures retain their own values.
Source ownership/cohorts, operand/entry/type/latch models, IRQ/shadow and absent
UART regressions pass again. None is PID 1 or real-browser acceptance.

Next: run these frozen corrected ABI-3 binaries on the unchanged full bundle/root image,
record the actual dominant term and next common gate, then continue to PID 1.
No cache quota increase or guest interpretation route is introduced.
