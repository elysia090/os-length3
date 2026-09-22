# Remaining work

## Goal

The deliverable is a Linux distribution that boots from its own post-link
output. The fixed `development-standard-v1` kernel image and every linked
`ET_EXEC`/`ET_DYN` in that profile are compiled after linking into equivalent,
ordinary, independently runnable optimized ELFs; each output is proved against
its ordinary linked input; the optimized packages are assembled into one
candidate root; and publication requires a same-identity reduction in canonical
release size and in paired native execution, measured natively first and through
the browser projection second. There is no runtime interpreter and no
missing-block fallback.

The normative boundaries are [README.md](README.md), [CONTRACT.md](CONTRACT.md)
and [BENCHMARK.md](BENCHMARK.md) for the compiler, and
[`../docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md) for the distribution. This
file is the remaining-work ledger toward that goal: it records what is green,
what is red, and the exact next witness. It never upgrades a partial result into
a release.

## Remaining work against the goal (2026-09-18)

**Green now.** The native product suite passes: `make -k check` exits zero for
all C products and selectors, and the post-link path is complete end to end for
real dynamic PIE inputs (`hello.elf` 17,800 -> 13,824 bytes, `primes.elf`
18,344 -> 13,824 bytes, zero normalization escapes, proof green, identical
execution, 401 paired benchmark samples with matching output and exit state).

**Stage 1, distribution recipe: environment prepared, build running.** The
Alpine 3.24.1 image and its 313-package `installed.lock` are the pinned *build
host* only; `environment.sh` states that bootstrap packages are never copied
into the product root. The product `development-standard-v1` is a separate
from-source musl closure defined by `data/sources.env` and
`data/distribution/package-recipes.sh` (Linux 7.1.8, musl 1.2.6, GCC 16.2.0,
binutils 2.46, BusyBox 1.37.0, apk-tools 3.0.7, s6/s6-rc, ...), with its own
signed apk v3 world and service DAG; those versions are not Alpine's packages.
The host is now reachable: 52 verified upstream archives, the pinned Alpine
image (SHA256 plus the pinned GPG signer) on a differential disk, and the exact
313-package bootstrap installed and compared equal to `installed.lock`, with
`environment.sh` reporting a `QM_BOOTSTRAP_ID`. The product kernel artifact is
the post-link compiled `bzImage` at `boot/kernel`; `vmlinux.unstripped` is only
the compiler input. `data/build-linked-kernel.sh bzImage` is running in the
guest, and the whole-kernel (743 escapes) and GNU make (49 escapes) scans from
the 2026-09-13 checkpoint become rerunnable once that linked input is copied
back.

The build host is also reproduced on a native Linux machine: a locally built
slirp-enabled QEMU 11.1.0 under KVM (`data/bootstrap/linux.py`, SSH on
127.0.0.1:18022), `data/fetch-upstream.sh` populating `data/upstream/` from
`data/sources.env`, and the pinned Alpine 3.24.1 image. The retained signed APK
inputs were refreshed to the current v3.24 stable point release on 2026-09-20
(`ca-certificates`/`ca-certificates-bundle` `20260611-r0` -> `20260909-r0`; the
installed population stays 313, the Rust closure stays 35), giving
`QM_BOOTSTRAP_ID=df4026a1c7c02b49c8d36782c1a361dca0e89f4616349c42f0458b95fcc15dd9`.
`build-native.sh` builds the native products and passes every instruction-level
check in the guest. The toolchain checkpoint
`x86_64-linux-musl-toolchain-f5e7fa887fa3ce95971c1bd71d46c4581f13250e6dec9733c29b1f71ad401ccb.packages`
is built, and `data/build.sh` is running against it.

The release-size unit is the single canonical Artifact program word
(`ARTIFACT.md`), at most 75,000,000 bytes after every linked `ET_EXEC`/`ET_DYN`
is replaced by its proved optimized ELF. It is not the 564 MB source-archive
population under `data/upstream/`, a tar extent, a SquashFS extent, or a storage
pack; the earlier 114,573,312-byte SquashFS figure was a deprecated
machine-pack backing, not a release-size result.

**Stage 2, optimized native x86: relaxation closure fixed (native emission green).**
The native relaxation fixed point had two defects, both now fixed.  First,
`relax_candidate_activate` measured the relaxed size with
`pl_x86_select_measure` while `form_population` re-selects the same block with
`select_block_under_limits`; the two spellings disagreed, so the recorded delta
did not match the layout the emitter actually built.  Second, and larger, the
three-bit relax rank was encoded inconsistently: activation set `covered` for
every nonzero delta, but `relaxed_delta_at` decodes
`(covered,relax_large,function_starts)` as the exact rank
`{000=0, 001=1, 010=2, 100=3, 101=4, 110=10, 011=0}`, so a true +1/+2 growth was
read back as +4/+10 and `form_population` drifted from the fit prediction.  For
the static glibc closure this surfaced as stage 4 at `0x459837 -> 0x4597a0`:
the fit pass predicted a 16-byte-later target than the final layout placed.
Activation now measures through `select_block_under_limits` with the block's own
bridge cost and writes the exact 3-bit rank.  The static glibc input then
reaches native emission green: `816864 -> 413752 bytes`, zero normalization
escapes.  A RELA section with `sh_link == 0` (symbol-free RELATIVE/IRELATIVE
rows, static `.rela.plt`) is read by a dedicated
`pl_elf_relocation_read_symbol_free`, without widening `pl_elf_relocation_read`
(which `observed-compile-check` depends on).  `make -k check` is green.

**Open reds: the valid `--emit-relocs` static input and the kernel scan.**  A
non-conforming static input (`/tmp/hello-static.elf`, linked without
`--emit-relocs`) previously published a green but non-equivalent binary: its
`.init_array`/`.fini_array` slots hold absolute code pointers with no covering
relocation, so the moved `.text` left them stale and the startup
`__libc_csu_init` called a stale address (`0x401810` = `__do_global_dtors_aux`).
`pl_x86_relocate_elf` now refuses any non-empty pointer-array slot that has no
relocation section for that array, so such an input fails the
construction-relocation gate instead of publishing; the self-contained
`relocation-free-product-check` fixture (no relocations, no cross-references)
still passes, and `make -k check` is green.

The valid `--emit-relocs` static input (`/tmp/tiny.elf`) previously stopped at
`selection_limits` stage 228: `pl_x86_select_candidates` returned
`PL_ERROR_X86_SELECT` for the block at `0x413edc` (`mov $0x2e,%eax;
lea 0x1(%rdi),%rdx; sbb $0xff,%al` consuming the incoming carry).  The frame
recursion probed `source_address_definition` at the ALU's byte width (8), and
both `source_address_definition` and `source_address_definition_uncached`
returned a hard error for any width other than 32/64.  They are lookups, so an
unsupported width is simply "no address definition": both now return 0.  Stage
228 is resolved and the byte `sbb`/`adc` and entry-condition shapes no longer
abort the whole selection.

The valid input now reaches **zero normalization escapes**
(`/tmp/tiny.elf`, native closure selected, `normalization-escape=0`).  The
mixed and nested select class was closed by extending the ALU frame:

- `measure_alu_tree`/`write_alu_tree` gained a nested-select case for the
  `SELECT(a, dst_entry, cc)` shape (materialise a **constant** true arm into a
  scratch, then `cmovcc dst,a`), restricted to a constant true arm so the
  `entry_select_overlay` guard fixture keeps its byte-exact schedule.
- `conditional_select_details` was split into an inner variant with an
  `allow_seed` flag.  When the compared operand has no physical local owner,
  the ALU frame now materialises it into a scratch via `measure_alu_tree` /
  `write_alu_tree` before the `CMP` (previously it returned 0, which was the
  `0x4032d0` escape).  The seeded operands are chosen from the frame scratch
  mask and excluded from later seeds.

`select-x86-check` and `make -k check` are green, and the post-link native
closure now reports **0 escapes** on the `--emit-relocs` static input.

**Dominant term resolved: the projection's per-block selection.**  The native
complete-future projection re-selected every partial block, and the dense ALU
frame's operand-tree search has no cost memo, so a single very large
straight-line plan is super-exponential: the 131-instruction block
`0xffffffff815ed881` drove more than 3,000,000 `measure_alu_tree` calls and
stalled the whole-kernel scan past an hour.  `measure_direct_alu_frame` now
declines a plan with more than 96 nodes (`node_count > 96u` returns
"not applicable"), so the polynomial live-range / shared-DAG frames or an exact
source projection own such blocks; nothing becomes an escape from the cap
(the whole-kernel scan still reports `normalization-escape=0`).  The kernel
post-link now runs end to end in **about 70 seconds** (was >1h17m) and reaches
the publication gate.

**Open red: the Pareto-unresolved class (static glibc `0x41bb01`).**  The kernel
witness `0xffffffff81397304` is resolved.  Its block
(`mov %r14,%rdx; movabs $0xffffffff00000000,%rcx; and %rcx,%r10; or %rax,%r10;
mov %r10d,%esi`) derives `esi = low32(rax)`, which the ALU frame published as
`mov %eax,%esi; and $0xffffffff,%esi`.  The 32-bit all-ones mask is the identity
on the lane and the publication's own 32-bit move already zero-extends, so
dropping it turns the normalized candidate from `2/6/24` into `2/5/21`, which
attains both minima and dominates the source `3/5/22`.
`lane_identity_mask_details` in `select-x86.c` now recognizes
`lane{32,64}.and(x, all_ones)` for a register base and emits only the lane-width
move in both the measure and write paths of the ALU frame.  The remaining
static witness is glibc `0x41bb01` (`3/11/38` vs `4/7/25`).

Two further kernel witnesses were cleared on the way.  `0xffffffff813a13c4`
(`and $0x20,%eax; mov %eax,%edx; shr $0x5,%dx; and $0x1,%edx`) exposed an
ALU-frame alias that the measure recorded on the selection and the write then
inherited: `physicalize_transient_operand` resolved the `lane64.and` base
through a stale alias and emitted `mov %edx,%eax` before EDX was defined.
`measure_direct_alu_frame` now records the publication loop's starting alias and
`write_direct_alu_frame` restores it, so both paths resolve operands from the
same state and the write reproduces its own measurement.  Kernel post-link then
reaches a new Pareto witness `0xffffffff813d0a5c` (`3/8/24` versus `4/7/23`),
and stops at native stage 235.

`0xffffffff813d0a5c`..`0xffffffff813d0a73` (`efi_partition+0x5dc`) is a
straight-line block of seven source instructions whose plan carries two
multiply chains: `LANE64_EXTEND32_S`, `lane64.and`, `LANE64_SHL`,
`X86_SHIFT_FLAGS`, `LANE64_INSERT`, then `MULR`/`MUL_HIGH`/`X86_MUL_FLAGS`
twice.  The normalized ALU frame reaches `span=3` at `work=8` (24 bytes); the
retained source is `span=4` at `work=7` (23 bytes).  The exact spelling gap is
the sign extension: the normalized candidate opens with `mov %ebx,%eax; cltq`
(two instructions) where the source uses `movslq %ebx,%rax` (one).
`sign_extend_node`/`emit_sign_extend_move` already produce the one-instruction
`movslq`, but this publication reaches the frame through a two-instruction
spelling instead, so the same span-3 schedule costs one extra work and the two
minima have no joint witness.  The plan holds the sign extension and the 32-bit
insert as two nodes over the same entry: `node1 = PL_OPCODE_EXTEND32_S(local3)`
and `node5 = LANE64_INSERT(0, local3, 32)`.  The frame emits
`mov %ebx,%eax` for the insert (its 32-bit zero-extend) and then `cltq` for the
`EXTEND32_S`, whose `local3` operand is resolved through the frame alias to the
insert's RAX result; one `movslq %ebx,%rax` expresses both.  Closing it means
recovering the joint publication — the frame (or the physical fold) must spend
one `movslq` when an `EXTEND32_S` and a same-source 32-bit insert are both live
— and keeping measure and write byte-identical.  A first attempt at a combined
production did not fire because the `EXTEND32_S` operand is the entry local, not
the insert node, so the alias, not the operand tree, carries the connection.

The frame's local map for this block is the stronger clue: every one of the
sixteen GPR locals is live, with `local0 = node3` (the shift),
`local1 = node5` (the 32-bit insert) and `local6..15` carrying the two multiply
chains.  `node1` (`EXTEND32_S`) is published to no local at all — it is
materialized inside a tree, which is what produces `cltq`.  `local1`'s only
candidate consumers are the `MULR`/`MUL_HIGH` nodes, and neither reads it, so
the two instructions exist because the complete-future mask keeps `local1`
live rather than because a real observer needs the zero-extended word.  Every
one of the plan's twelve nodes has been read: `node2 = and(local6,local7)`,
`node3 = shl(node2,7)`, `node6 = mulr(local8,node2)`,
`node7 = mul_high(node2,local8,320)`,
`node8 = mul_flags(local4,local6,local7,320)`, `node9 = mulr(local7,local8)`,
`node10 = mul_high(local8,local7,320)`,
`node11 = mul_flags(local8,local9,local10,320)`, plus `node1`/`node4`/`node5`.
No consumer reads `node1` or `node5`; they are pure outputs kept live by the
complete-future mask (`local0` and `local1`).  So the fold is not in the ALU
frame but in the projection: either the lowering must not keep the 32-bit
insert live when a signed extension of the same entry is its only sibling
publication, or the frame must be told that one `movslq` publishes both.  The
next step is to trace how `pl_x86_block_lower_projected_until`'s live mask
acquires `local1`, since that mask, not the node graph, is what forces the
extra work.

That trace is now done.  `pl_x86_native_project_live_outputs` sets
`forced[state] = all_outputs` for an external block (a successor outside the
closed image, a dynamic target, or an unclosed arm), and this block exits to
another function, so every GPR local is live (`live=0x7ffff`).  A reference
census settles the graph: `node1 = EXTEND32_S(local3)` is read by `node3` and
`node4`, `node3 = shl(node1,7)` is `local0`, `node4 = shift_flags(node3,...)`,
and `node5 = insert(0,local3,32)` is `local1`.  The retained source publishes
the two extensions in **different registers** (`movslq %ebx,%rax` and
`mov %ebx,%ecx`); the normalized frame serialized both into RAX
(`mov %ebx,%eax` then `cltq`), so the extension of `node1` was spelled relative
to the incoming accumulator instead of from its own register.  `write_alu_tree`
and `measure_alu_tree` now spell a 32-bit `sign_extend_node` operand as the
direct one-instruction `movslq` **before** `write_alu_seed`/`measure_alu_seed`
can resolve it through the transient alias, which removes the spurious producer
and the extra work.  Kernel post-link then clears `0xffffffff813d0a5c` and
reaches the next Pareto witness `0xffffffff81430efd` (`4/9/27` versus
`5/7/26`).

`0xffffffff81430efd`..`0xffffffff81430f17` (`xz_dec_lzma2_run+0x6ed`) is a
seven-instruction block whose plan is
`node1 = insert(0,local2,32)`, `node2 = add(local15,node1)`,
`node3 = and(local63,node2)`, `node4 = ADD3(local13,local15,node1)`,
`node5 = compare(local16,node3,8,...)`.  The normalized candidate publishes
`node2` and `node4` independently, so it materializes `node1` and
`add %r15,%rcx` twice (27 bytes, `work=9`, `span=4`); the retained source shares
`node2` and spends one extra `add %r13,%rcx` (26 bytes, `work=7`, `span=5`).
`node4` is already an `ADD3` whose two operands (`local15`, `node1`) are exactly
`node2`, so `shared_dag_add3_pair` re-associates it to `ADD(node2, local13)`.
The next step is to make the ALU frame actually take that re-association when it
publishes `node4`, so one `add` covers both nodes.

The re-association alone is not enough.  Neither `node2` nor `node1` is
published to a local — the plan's only GPR publications are `local0 = node3`
and `local1 = node4` — so when `node4` is re-associated to `ADD(node2,local13)`
the frame still materializes `node2` inside `node4`'s tree, and `node3`'s tree
materializes it a second time.  The retained source keeps `node2` in RCX and
shares it.  A first attempt added a `shared_dag_add3_pair` case to the frame's
node fallback in both paths, but it does not fire: a direct probe shows
`shared_dag_add3_pair` itself returns 0 for `node4` even though
`node2 = lane64_add(local15,node1)` matches two of `node4`'s operands and
`arithmetic_tree_details(node2)` should report `mode=1, bits=64`.  The frame
reaches `shared_dag_add3_pair` only after `collect_native_affine_lea`, which
already accepts `ADD3(a,b,c)` as one LEA, so the re-association case placed after
it never fires.  The case now sits ahead of `collect_native_affine_lea` in both
paths.  Probing the exact witness confirmed the relation is real: for
`node4 = ADD3[1](local13,local15,node1)` the walk reports
`arithmetic_tree_details(node2) = 1, mode=1, bits=64` with
`left=local15, right=node1`, exactly two of `node4`'s operands.  The case still
did not fire because its guard compared the returned width against the `bits`
variable, which at that point had not yet been computed for this publication;
dropping the width guard (the re-association already carries its own width) lets
the frame take it.  Kernel post-link then clears `0xffffffff81430efd` and reaches
the next Pareto witness `0xffffffff813fd7ff` (`3/9/29` versus `5/8/24`).

`0xffffffff813fd7ff`..`0xffffffff813fd81c` (`__genradix_ptr_alloc+0xff`) is a
nine-instruction block with `node1 = shl(local15,1)`,
`node2 = add(local15,node1)`, `node3 = ADD3_32(local15,node1,node2)`,
`node4 = and(local16,local3,-16,...)`, `node5 = and(local15,node1)`,
`node6 = bit_summary(node4,local12,64)` (the `bsr`) and
`node7 = compare(local16,node5,1552,...)`.  Three no-reassociation candidates
exist: `span=3` at `work=9` (29 bytes, three independent
`lea (%r15,%r15,2)`), `span=5` at `work=8` (24 bytes, one shared `lea` plus
`add %ecx,%ecx`), and the retained source `span=5` at `work=9` (29 bytes).  The
joint minimum needs `span=3` and `work=8` at once, so the short schedule must
share the `node1`/`node2`/`node3` family the way the long one does.  `node3` is
already an `ADD3` whose operands include `node1` and `node2`, so
`shared_dag_add3_pair` is the same mechanism that closed `0xffffffff81430efd`.

That mechanism is now measured on this witness and it is *not* the fix.
Instrumenting the exact block shows the helper does fire at `node3`:
`node3 = ADD3_32(local15, node1, node2)` re-associates to `ADD(node2, node2)`
(`pair=node2`, `remaining=node2`, `bits=32`), and both measure and write take it,
yet the ALU candidate stays `span=3`/`work=9`.  Dumping the three candidate byte
streams explains why.  The ALU frame publishes `local1 = node3` then
`local2 = node5`, and it already collapses each publication to one instruction:
`node1`/`node2` become `lea (%r15,%r15,2)` and `node5 = local15 + node1` becomes
the same `lea (%r15,%r15,2)` (`local15 + 2*local15`), giving 9 instructions in 3
waves.  The `span=5`/`work=8` candidate is the **`direct_frame`**, which folds the
`+9` of `node7` into a `lea 0x9(%rcx),%edx` and issues the `bsr` later.  So this
is not a missing share; it is the genuine span/work tradeoff the Pareto gate is
for: the short-wave ALU schedule cannot fold the extra displacement without
adding a wave, and the long-wave direct schedule cannot shorten its dependency
chain.  Resolving it needs a cost-canonical rule (or a schedule that folds the
displacement while keeping the `bsr` early), not another re-association.

The contract rules out the easy half of that: `CONTRACT.md` requires `sigma` and
`tau` to be *independently minimized* by **one** candidate and says that when the
two minima have no joint witness "the Pareto frontier remains unresolved and
publication fails", so the gate may not be relaxed to prefer the lower-work
candidate.  The only admissible fix is a frame that attains `span=3` and
`work=8` together.  Decoding the two byte streams narrows the required
production: the direct frame folds `node7`'s compare displacement into
`lea 0x9(%rcx),%edx` over the already-computed `node5 = 3*local15`, while the
ALU frame spends its third wave on `bsr` and keeps `node5` as the bare
`lea (%r15,%r15,2)`; the ALU frame therefore needs a production that both keeps
the `bsr` early and folds the `+9` into the `node5` publication, or the direct
frame needs a shorter dependency chain.  Neither has been implemented.

One further measured fact narrows the target.  The retained source computes
`node5 = 3*r15` into ECX, then `add %ecx,%ecx` and `lea 0x9(%rcx),%edx`, i.e. it
doubles the value it already holds.  The plan's `node3` is that doubling, and a
valid pair for it is `node5` (`ADD3(local15,node1,node2)` with
`local15 + node1 = node5`), which **already has an architectural publication**
(`local2`).  `shared_dag_add3_pair` scans only `candidate < node_number`, and
`node5` is node 5 while `node3` is node 3, so the scan can never see it and
picks the unpublished `node2` instead.  Extending the scan past `node_number` is
the obvious route, but a first attempt that also preferred published candidates
**segfaulted** the compiler on the kernel (the emitted `pair`/`remaining` were
not constrained to the frame's expected ordering), so it was reverted.

The segfault is now explained rather than merely observed.  Printing the ALU
frame's laws for this exact block gives `changed = 0x27` with
`L1 (node3) src=0x8000 dep=0x0` and `L2 (node5) src=0x8000 dep=0x0`: both are
computed from entry local 15 alone, and the frame records **no** relation
between them.  So a publication that reads `local2` would read a register the
scheduler never ordered — the crash class.  Any fix must therefore make the
relation visible to the frame's source laws, not just to the helper.  The
correct form is a **fold-plane** rewrite: rewrite the local that publishes
`node3` to `ADD(<the local that publishes node5>, node2)`, so
`alu_frame_source_laws` yields `dependencies[L1] = bit L2` and
`next_alu_frame_assignment` orders `local2` before `local1` by the existing
mechanism.  The invariant this must preserve, and which the failed attempt
violated: a rewritten publication may reference a **published local** or an
earlier node, never a later node.  Not yet implemented.

Implemented and measured: `shared_dag_add3_published_pair` finds the pair among
**published locals** (comparing the ADD3's operands with the operands of the
published add, never naming a later node), `alu_frame_source_laws` records the
matching dependency so `next_alu_frame_assignment` orders the pair first, and
both frame paths take the case ahead of the earlier-node form.  This fires
(`MPUB/WPUB node=3 pairL=2 bits=32`) and shrinks the ALU candidate for the
`ADD3` block from 29 to 27 bytes, with no crash, and `make check` plus the
differential fuzz are green.

A follow-on narrowing was tried and rejected.  `equal_lane_add` recognized that
an ADD3's remaining operand and its published pair are the same lane add written
at different widths (`node2 = ALU_REGISTER[1][1](local15,node1)` versus
`node5 = ALU_IMMEDIATE[0][1](local15,node1)`, equal in the low word), and coerced
the operand to the pair local to avoid a second materialization.  The condition
does hold (`eq=1` once the local is resolved through `plan->locals`), but
applying it globally changed other blocks' schedules: the witness's own ALU
candidate moved from `span=3` to `span=4`, and it is not sound in general
because the wide node also feeds a `MUL_HIGH` that observes its high bits.
Reverted; the tree keeps only the published-pair change.

Correction to the ledger below: the `ADD3` block whose ALU candidate went
29 -> 27 bytes is `0xffffffff81430efd`, not `0xffffffff813fd7ff`.  The two share
the `local15`/`node1` shape and were conflated during this work.

The doubling rule was then tried properly and rejected, for a decisive reason.
`0xffffffff813fd7ff` and `0xffffffff81430efd` have the same `ADD3` shape
(`ADD3(a,b,c)` with `a+b = c` as a published value), yet they need *different*
spellings: emitting the doubling (`materialize c; add dst,dst`) clears
`813fd7ff` but moves `81430efd` from `span=3` to `span=4`, reopening a Pareto
that was already resolved; emitting the pair-add keeps `81430efd` at `3/9/27`
but leaves `813fd7ff` unresolved.  Verified both ways by building each variant
and re-running the kernel: the frontier follows the variant, and reverting
restores `81430efd` at `3/9/27` with `813fd7ff` back as the witness.  So no
per-node emission rule can decide this: the correct spelling depends on the
block's whole schedule.  The fix has to be at **candidate selection** — the ALU
frame should offer both spellings for the same block and let the existing
joint-minimum/Pareto gate choose per block — not a single hard-coded branch in
the frame.

Multi-candidate emission was then attempted and reverted.  The shape was: a
`add3_double_variant` flag on the selection, the published-pair branch honoring
it, and a second grammar entry (`measure_direct_alu_frame_doubling`) that sets
the flag before delegating.  With both entries the stop moved to
`0xffffffff81430efd`, and the frontier became `4/9/27 4/9/27 5/7/26`: the
doubling spelling clears `0xffffffff813fd7ff` but makes the previously-resolved
`0xffffffff81430efd` Pareto-unresolved, so the pair spelling and the doubling
spelling are needed by *different* blocks and neither may be made global.  The
work was reverted to the published-pair-only state, which reports one unresolved
block (`pareto=1 at 0xffffffff813fd7ff`, frontier `3/9/27` vs `5/8/24`).

Two controls separate causes from noise.  Disabling the published-pair branch
restores `3/9/29`, confirming that branch is a real 2-byte improvement on
`0xffffffff813fd7ff`.  Adding a second, behaviourally identical
`measure_direct_alu_frame` entry leaves the decision unchanged (still
`pareto=1 at 0xffffffff813fd7ff`) and only lengthens the informational frontier
listing to `3/9/27 3/9/27 5/8/24`, so duplicate entries are harmless and the
`81430efd` regression is caused by the doubling spelling itself, not by adding a
grammar row.  `pareto=1` counts blocks, not candidates: at most one block is
unresolved at a time, and `0xffffffff81430efd` is resolved until the doubling
spelling disturbs it.

The open design question is therefore narrower than "independent measurement":
the ALU frame must offer the doubling spelling only to blocks where it wins, and
the only sound way to know that is to measure both spellings for the block and
let the joint-minimum gate choose.  That requires the two measurements to not
perturb each other's schedule — the failing coupling is between the two ALU
frame spellings for the same block, and it must be removed before the second
spelling can be registered.

A later attempt to re-add the doubling variant confirmed one practical point and
failed on another.  Re-splicing the doubling arm into the existing
`if (!write_alu_pair(...))` in the write path is not viable: the edited control
flow broke `native stage 228` on an unrelated block (`0xffffffff812be3df`,
`output=0x401 expected=0xffffffff`).  The doubling arm must be written as a
complete, byte-symmetric branch in both `measure_direct_alu_frame` and
`write_direct_alu_frame`, mirroring how the published-pair arm was added, rather
than patched into the pair call.

Writing it that way — one candidate per block, with the pair arm choosing the
doubling spelling whenever `remaining` is value-equal to the pair — still
regressed `0xffffffff81430efd` to unresolved (`4/9/27` vs `5/7/26`) while
clearing `0xffffffff813fd7ff`.  The decisive observation is that
`0xffffffff81430efd` **never enters the published-pair branch** (instrumenting
it prints only `PP start=0xffffffff813fd7ff dbl=1 pairL=2 rem=k3/2 bits=32`), so
the doubling spelling is not what breaks it: the two-block conflict is
**indirect**, produced by the changed control flow around the pair arm, not by a
second spelling for the same node.  That is why every local rule tried so far
trades the two blocks: the tie is between two *frames'* schedules over the same
plan, and only the per-block candidate comparison can arbitrate it.  Reverted
again to the verified published-pair-only state (`pareto=1 at
0xffffffff813fd7ff`, frontier `3/9/27` vs `5/8/24`).

The mechanism is now localised to a register-owner choice.  The verified ALU
candidate for `0xffffffff813fd7ff` is
`bsr r12->rax; lea (r15,r15,2)->edx; lea (r15,r15,2)->ebp; mov edx->ecx;
add ebp,ecx; mov rbx->rbp; and $-16,rbp; cmp eax,edx; jle` — nine instructions,
where `edx` and `ebp` hold the **same value** (`3*r15`, nodes 2 and 5) and the
`mov edx->ecx` is pure overhead.  Materialising that value once and adding it to
itself would reach `work=7` at the same `span`, i.e. below even the direct
frame's `work=8`.  The doubling arm was meant to do this but measured
`span=4`: it materialises into `local1`'s destination, whereas `node2` is
already in `edx` for the `cmp`, so moving the value late lengthens the chain to
the compare.  The fix is therefore not "double in the destination" but "reuse
the register the frame has already chosen for that value, and add in place",
i.e. an owner/alias decision inside `write_alu_pair` that the scheduler's wave
assignment must agree with.  Writing the doubling arm by splicing it into the
existing `if (!write_alu_pair(...))` is not viable — that broke `native stage
228` on unrelated blocks twice (`0xffffffff812be3df`, `0xffffffff812ce0f5`),
because the measure and write paths have to change together as complete
byte-symmetric branches.

The two materialisations are not simply redundant: the plan keeps both
`local1 = node3` and `local2 = node5` live, and `node7` reads `node5` while
`node3` is its own publication, so the ALU frame must publish two values even
though they share the `local15`/`node1` family.  The direct frame avoids the
second one by folding the compare displacement into a `lea`, at the cost of one
more wave.  So the joint minimum still needs a schedule that both publishes the
shared family once and keeps the compare chain short; that is not reachable by a
local operand-owner change.  (A narrower relaxation of `shared_dag_add3_pair`'s
width check — accepting a 64-bit pair for a 32-bit `ADD3`, sound because the low
32 bits of a 64-bit add are the 32-bit add — was applied earlier and changed
nothing, confirming width was not the blocker.)

Hand calculation at this point read the plan literally, and it is one register
decision.  Writing the plan as `x = local15`: `N1 = 2x`, `N2 = x + 2x = 3x`
(64-bit), `N5 = x + 2x = 3x` (32-bit), `N3 = x + 2x + 3x = 6x = N5 + N5`, and
`N7` compares against `N5`.  `N3 = N5 + N5` because `N2` and `N5` are the same
value, so `N2` need never be materialised.  The source does exactly this in one
register: `lea (%r15,%r15,2),%ecx` puts `3x` in ECX, then `add %ecx,%ecx` makes
`6x` — ECX serves both `N5` and `N3`, and the compare operand is the displaced
`lea 0x9(%rcx),%edx`.  The ALU frame instead materialises `3x` twice
(`lea ->edx` for the compare and `lea ->ebp` for the `ADD3` operand) and spends
a `mov` joining them, which is the whole one-instruction gap at `work=9`.
The fix appeared to be a **destination choice**: publish `local2 = N5` first
into a register and then emit `local1 = N3` as an in-place `add reg,reg` of that
same register, rather than materialising `N2` into a separate coordinate.  That
is `next_alu_frame_assignment` choosing `local2`'s register for `local1`'s
in-place doubling, with both frame paths emitting it byte-identically; the
earlier `add3_double_variant` attempt failed because it materialised into
`local1`'s own destination instead of reusing `local2`'s, which lengthened the
chain to the compare.

That reading was wrong, and the later section below records why: the plan's
`N7` compares `N5 = 3x` with `bsr`, but the source compares `6x+9` with `bsr`,
so the plan has no node for the real compare operand at all.  The `work=9`
"gap" was an artefact of emitting the wrong value, not of a register choice.

That destination choice was then implemented and measured, and it cannot be made
to work in the ALU frame.  The change was: the published-pair arm rewrites
`remaining` to the pair local when the two are value-equal, and
`write_alu_pair`/`measure_alu_pair` gain an `add`-mode self branch that emits
`add reg,reg` on the pair's own coordinate.  Result: `0xffffffff813fd7ff`
clears, but `0xffffffff81430efd` regresses to `4/9/27` (from resolved) and the
frontier becomes `4/9/27 5/7/26`.  The reason is structural: `node7` reads
`node5` (`local2`), so doubling `local2` in place destroys a value the compare
still needs, and the frame must first copy `local2` aside — which is exactly the
extra instruction and wave.  The source avoids this only because its compare
operand is derived from the *doubled* value (`lea 0x9(%rcx),%edx`), i.e. its
`node7` does not read `3x` after the doubling, whereas this plan's `node7` does.
The change was reverted; the tree keeps the published-pair-only state
(`pareto=1 at 0xffffffff813fd7ff`, frontier `3/9/27` vs `5/8/24`).

The next step is therefore **not** the frame at all.  Executing the exact
27-byte candidate bytes

    49 0f bd c4        bsr    %r12,%rax
    43 8d 14 7f        lea    (%r15,%r15,2),%edx
    43 8d 2c 7f        lea    (%r15,%r15,2),%ebp
    89 d1              mov    %edx,%ecx
    01 e9              add    %ebp,%ecx
    48 89 dd           mov    %rbx,%rbp
    48 83 e5 f0        and    $-16,%rbp
    39 c2              cmp    %eax,%edx
    7e 00              jle

against the 24-byte live frame on 500,000 random `(r15,r12,rbx)` triples
produced **zero** identical results.  The live frame (and the source) compares
`6x+9` with `bsr`; this candidate compares `3x` with `bsr`.  It is a
miscompile, not a cheaper schedule: the `span=3` point is unreachable for the
real comparison.  The Pareto gate is what keeps it out of the artifact — the
block is never emitted, so `postlink-verify` never runs on it — which is why
the frontier looked like a genuine tradeoff.

The plan itself carries the discrepancy.  For this block it lists
`N7 = COMPARE(flags, N5 = 3x, proj1552 = proj(N6) = bsr)`; there is no node for
`6x+9` at all, while the source is `lea 0x9(%rcx),%edx` with `%rcx = 6x`.
`proj1552` is a selector-16 projection, which `bit_summary_details` defines as
the `BIT_SUMMARY` node itself, so the second operand really is the `bsr`
result.  `write_direct_alu_frame` emits exactly the plan's operands, so the
fault is upstream of the frame, in whichever rewrite produced the compare's
operand pair (`pl_reopen_consumed_x86_alu*` / `pl_fold_local_physical` /
`pl_compact*` are the candidates).  This is the same class as the flag-producer
miscompile above: a plan that `postlink-verify` and `make check` accept, made
observable only by executing the synthesized bytes.

The true joint minimum is `span=4, work=8`, and it *is* reachable:

    lea    (%r15,%r15,2),%ecx     ; 3x
    mov    %rbx,%rbp
    lea    0x9(%rcx,%rcx,1),%edx  ; 6x+9
    add    %ecx,%ecx              ; 6x
    and    $-16,%rbp
    bsr    %r12,%rax
    cmp    %eax,%edx
    jle

is byte-for-byte semantically identical to the 24-byte live frame over
1,000,000 random inputs, at `span=4` instead of `span=5`.  `span=3` is
impossible for the correct comparison: `6x+9` from `r15` needs two dependent
LEAs (`lea 3(,r15,2)` then `3*(2x+3)`, or `lea 3x` then `lea 2*(3x)+9`), so the
compare operand exists only at depth 1, `cmp` at depth 2 and `jle` at depth 3.

Forcing the smallest-span candidate at this block (debug-only) advances the
compile past it but immediately makes `0xffffffff81430efd` Pareto-unresolved
with frontier `4/9/27 5/7/26`, confirming the two witnesses are coupled through
code layout rather than sharing a spelling.  The next target is the rewrite
that builds the compare operand, not the frame and not the selector.

**Stage 3, measured performance gate: not started.** Only the tiny real
workloads above are paired; there are no fixed source identities, canonical
roots, or `postlink-workloads.tsv` measurements.

**Stages 4-6, Artifact / Storage / Wasm / VM boot: not started.** The Wasm
backend still returns `WASM_COMPILER_ERROR_INCOMPLETE`, no release artifact is
published, and no product boot or browser cold shell has been validated.

## Current work: 2026-09-21 (813fd7ff cleared: a rewrite truncation, not a Pareto tradeoff)

The open witness `0xffffffff813fd7ff` reported frontier `3/9/27` (dense ALU
frame) versus `5/8/24` (copied-source live frame), and no joint minimum. The
`span=3` arm was not a cheaper schedule for the real block: executing its exact
bytes against the live frame on 500,000 random inputs gave zero agreement. The
live frame (and the source) compare `6x+9` with `bsr`; the ALU arm compared
`3x` with `bsr`. The Pareto gate stopped the block before emission, so
`postlink-verify` never ran on it — the same "green but wrong" class as the
flag-producer miscompile below.

Dumping the plan after every block-formation pass located the defect precisely.
The pre-rewrite plan is correct (`COMPARE(N8 = bsr, N7 = 32-bit(N6))` with
`N6 = ADD(proj1040, 9)`), and every pass preserves it except
`pl_fold_local_physical`. Its rule for `ADD3(a,b,c) + k` overwrote the staged
operands with the ADD3's three inputs *before* checking that one of them is a
constant to fold `k` into. When none is (as here, `ADD3(L15,N1,N2) + 9`), it
left `opcode = ALU_IMMEDIATE` and `argument_count = 2`, emitting the malformed
`ALU_IMMEDIATE(L15, N1) = 3x` — silently dropping both `c` and `k`.

The fix selects the constant slot first and only rewrites the node when one
exists; otherwise the outer `ADD3 + k` spelling is preserved. It also copies all
three operands rather than stopping at the constant, which removes a second
latent truncation when the constant is not the last slot. `check/physical.c`
gains an `ADD3`-without-constant fixture: it is RED before the fix and green
after. With the fix the ALU frame for this block is a correct `span=5, work=9`
spelling (verified identical to the live frame over 1,000,000 inputs), the live
frame's `5/8` becomes the joint minimum, and the witness clears. The kernel
frontier advances to `0xffffffff81430efd` (`4/9/27 5/7/26`).

The genuinely minimal schedule for the old witness was `span=4, work=8` (fold
the `+9` into the doubling LEA), but the contract only requires a joint minimum
among the offered candidates, and `5/8` satisfies it; the `4/8` spelling remains
an unclaimed improvement.

`0xffffffff81430efd` (`xz_dec_lzma2_run`) was the next frontier, and it was the
same class of phantom: its `4/9/27` arm republished the live register after the
compare, so the terminal `jb` read the flags of a following `add` instead of
`cmp rax,8`. Executing the two candidates on 1,000,000 random inputs gives
identical values but a different branch condition (CF) in 500,207 cases. The
plan is sound; the defect is the clobber classifier.
`publication_tree_clobbers_flags` treated an `ADD3` as flag-preserving whenever
its operands were, but a three-input add is a single `LEA` only when one input
is a constant displacement; three non-constant inputs (including a live
carry-in) need a second, flag-clobbering `add`/`adc`. With that corrected, the
dense ALU frame keeps the compare textually last and offers a legal `5/9`
spelling, so the copied source's `5/7` is the joint minimum and the witness
clears. `check/select-x86.c` gains an `add3_before_flag_producer` fixture that
asserts a joint minimum exists for the shape: RED before the fix, green after.
The kernel frontier advances to `0xffffffff8143353c` (`7/16/66 8/14/49`).

Both fixes are in the same "the Pareto gate hides a miscompile" family as the
flag-producer miscompile below: a candidate that `postlink-verify` never sees
because the block is never emitted.

See the "The next step is therefore **not** the frame at all" subsection above
for the old bytes and plan dump.

### 2026-09-21 (later): 8143353c cleared — a split publication, then a shared pair

`0xffffffff8143353c` (`dql_completed+0xdc`) was the next frontier, reported
`7/16/66` (dense ALU frame) versus `8/14/49` (copied source).  Executing the
exact bytes of the span-7 arm against the source on 1,000,000 random inputs
gave **zero** identical results (249,715 value-and-flag matches; 750,285 value
mismatches), so the short arm was again a miscompile the Pareto gate was
hiding, not a schedule trade-off.

Two defects in the dense ALU frame's conditional-select emission produced it,
both in the same publication.  The frame wrote the true-arm candidate *before*
seeding the compare operand, so (a) the scratch pool handed to the compare seed
still contained the candidate's coordinate and the seed clobbered it, and (b)
the compare tree rebuilt the `current` value from an entry local that the same
publication had already overwritten by materialising that arm destructively.
The emitted `imul rdx,rax,0x40` therefore read the value already shifted once
(`L0<<12` instead of `L0<<6`) and `cmovs rax,rcx` selected the pre-increment
arm.  The fix seeds the compare operand(s) first, excludes the destination and
the chosen candidate coordinate from the scratch pool passed to the seeds, and
records a transient value alias `current -> local` so the seed resolves the
materialised arm instead of rebuilding it (`push_frame_value_alias`).  measure
and write carry the identical order and alias state; a new
`value_alias_frame_count` checkpoint makes the write path begin from the alias
population the frame started with rather than the one the completed
measurement left.

That makes the arm correct, but only reaches `7/15` against the source's
`8/14`, so the component minima still have no joint witness.  The remaining
work is one materialisation.  The plan's `N9 = ADD3(L8, N7, 63)` shares its
pair `N8 = N7 + 63` with the sibling select `N12`, whose destructive arm is
exactly `N8`; `shared_dag_add3_pair` already re-associates the ADD3, but the
pair was built into `N9`'s own destination, so `N12` rebuilt `N7`/`N8` a second
time.  When the pair is also the `current` arm of a still-pending publication
(found by `alu_add3_pair_consumer`), the frame now builds the pair in that
consumer's coordinate and produces this publication's result through it, so one
materialisation serves both.  The correct candidate reaches **span 7, work 14**
and jointly attains both minima against the source's `8/14`.

`check/select-x86.c` gains an `add3_shared_pair_consumer` fixture built from the
exact 14 source instructions: it is RED (`status=-50`, component minima `7/14`)
before the sharing change and green after.  `make -k check` is green (79
targets), the 120-case differential fuzz reports 0 mismatches, and the new
candidate executes identically to the source on 1,000,000 random inputs.  The
kernel frontier advances to `0xffffffff814af477` (`2/7/18 3/6/17`).

`0xffffffff814af477` (`skb_segment_list+0x1c7`) is a **genuine** span/work
tradeoff, unlike the recent phantoms: both offered candidates execute
identically to the source on 1,000,000 random inputs.  The plan is five nodes
over one negated entry word:

```text
N1 = sub(L2, L6)      -> L7 (RDI)   N2 = sub(0, L6)    -> L0 (RAX)
N3 = flags(0, L6, N2) -> L16        N4 = add(L1, L6)   -> L2 (RDX)
N5 = EXTEND32_S(N2)   -> L6 (RSI)
```

The dense ALU frame published `L0 = N2` as `mov eax,esi; neg eax` (two
instructions into RAX), then `L6 = N5` as `neg esi; movslq rsi,esi` -- a second
materialization of the same `N2`.  It reached **span 2, work 7**; the copied
source reached **span 3, work 6**, and the component minima had no joint
witness.

The 32-bit sign-extension branch of `measure_alu_tree` / `write_alu_tree` only
consulted an operand that is literally a register (via `sign_extend_node`).  A
node argument fell through to a path that materialized the node into the
destination before the `movslq`.  Both now call `sign_extend_value` and, when
the argument is a node, resolve it through `published_operand_local` and emit
one `movslq` from that coordinate; the frame's source law already orders that
publication first.  For this block `L6` becomes `movslq rsi,rax`, the frame
reaches **span 3, work 6**, and the copied source's `3/6` is the joint minimum,
so the witness clears.

`check/select-x86.c` gains an `extend_published_node` fixture built from the
exact six source instructions: RED (`status=-50`, component minima `2/6`)
before the change, green after.  `make -k check` is green (79 targets) and the
120-case fuzz reports 0 mismatches.  The hand schedule

```text
sub rdx,rsi; mov rdi,rdx; lea edx,[rcx+rsi]; neg esi; movslq rsi,esi; mov eax,esi
```

is also byte-equivalent to the source on 1,000,000 random inputs and is
**span 2, work 6**; the frame still does not reach that optimum (it would need
`L0` to be published as a copy of the extension's in-place coordinate), so the
`2/6` spelling remains an unclaimed improvement.  The kernel frontier advances
to `0xffffffff8154f94e` (`3/6/18 4/4/14`).

`0xffffffff8154f94e` (`tcp_set_congestion_control+0x1ce`) was the same
"the Pareto gate hides a miscompile" class.  Its plan publishes
`N2 = shl(edx, ecx & 31)`, `N3 = and(N2, 0xffffefbf)` whose flags are the
select's condition, `N5 = select(RAX, RDI, ZF(N3)) -> RDI`, and the `and`'s
value as `L3 = projection(N3)`.  The dense ALU frame ordered the select `L7`
*before* `L3` and, because the final flag node has a value publication, skipped
`emit_select_compare`.  The emitted `cmove` therefore read the `shl` flags, not
the `and` flags: on `rdx=1, cl=6` the source copies `RAX` into `RDI` while the
candidate leaves `RDI` unchanged.  1,000,000 random inputs miss it because the
`shl` and `and` results disagree only when `(edx << cl)` is exactly `0x40` or
`0x1000`.

`add_flag_chain_dependencies` now also orders a conditional select that tests
the final flag node after the publication that owns that flag node's value
(reached through `flag_result_operand`, so it also works when the value
publication is a projection).  The block resolves to the source's **span 4,
work 4**; the ALU frame declines this shape and a live-frame production emits
the exact source spelling.  `check/select-x86.c` gains a
`flag_select_value_publication` fixture: RED (`status=-50`, minima `3/4`)
before the dependency, green after.  `make -k check` is green and the 120-case
fuzz reports 0 mismatches.  The kernel frontier advances to
`0xffffffff815ad0b6` (`5/12/40 6/10/26`).

`0xffffffff815ad0b6` (`ndisc_router_discovery+0xd6`) is another phantom.  Its
11-node plan builds `eax` from `ecx`:

```text
N1 = insert(0, L1, 32)    N2 = L1 + L1        N3 = L1 & 255
N4 = N3 >> 1              N5 = insert(N1, N4, 8)   N6 = N2 & 128
N7 = N5 & 64              N8 = N6 | N7        N9 = L2 & 0xffffff3f
N10 = N8 | N9  -> L0 (RAX)   N11 = compare(L16, N10, L2) -> RFLAGS
```

The ALU arm's exact bytes are

```text
8d 04 09 25 80 00 00 00 89 c9 48 81 e1 ff 00 00 00 48 d1 e9
83 e1 40 09 c8 b8 3f ff ff ff 48 89 d1 48 21 c1 09 c8 39 d0
```

and executing it against the source on 1,000,000 random inputs gives **zero**
identical results.

The plan republishes the entry coordinate: `L1` is both the entry `RCX` read
by `N1`/`N2`/`N3` and the destination of `N9 = L2 & 0xffffff3f`.  A correct
schedule must evaluate the entry-`RCX` subtree `N8` first and only then
overwrite `RCX`.  That is exactly the generation-join handoff: it seeds `N8`
into the join destination EAX, then publishes `L1 = N9`, then joins with
`or eax, ecx`.  The defect was the join's law update:
`apply_generation_join_laws` set `sources[destination] = 0`, so the seeded
coordinate no longer appeared in any source law and the next publication chose
EAX as its scratch.  `N9`'s 64-bit `and` mask `0xffffff3f` is not a
sign-extendable `imm32`, so its constant was materialized into EAX -- the
coordinate holding the unfinished `N8` -- and `N10 = or(N8, N9)` collapsed to
the constant (0/1,000,000 agreement).

`apply_generation_join_laws` now names the seeded destination as its own entry
source (`sources[destination] = 1 << destination`) instead of clearing it.  The
coordinate is live until the join, so it stays out of every other
publication's scratch pool, and no producer edge appears because no other
pending publication writes it.  The block resolves to the source's **span 6,
work 10** (with a correct `7/11` alternative offered); the ALU frame declines
the shape.  `check/select-x86.c` gains a `generation_join_seed_destination`
fixture: RED (`status=-50`, minima `5/10`) before the one-line change, green
after.  `make -k check` is green and the 120-case fuzz reports 0 mismatches.
The kernel frontier advances to `0xffffffff815cde46` (`3/6/16 4/4/11`).

`0xffffffff815cde46` (`ipv6_mc_check_mld+0xd6`) is another phantom, and
clearing it exposed a much larger, previously masked failure.  Its plan is
`N1 = sub(L1, L6)`, `N2 = add(L0, N1) -> L2`, `N4 = insert(0, N2, 16) -> L0`
and `N3 = flags(...)` whose value result is `N2`.  `publication_for_emission`
rewrites an insert publication of the final flag result to the inserted value
-- correct for an in-place low-lane write, but here `insert(0, N2, 16)` is a
16-bit zero extension of the 32-bit `N2`, so the rewrite published `N2`'s full
word.  The frame then emitted `add eax,eax` (both operands resolved to the
destination) and reached span 3, work 6 against the source's 4/4.

`publication_for_emission` now refuses that rewrite when the insert is a
zero-based lane extension narrower than a register word **and** the inserted
value already has its own publication.  `L0` then emits the real
`movzx eax, dx`, the frame and source both reach **4/4**, and the Pareto
clears.  `check/select-x86.c` gains a `zero_extend_flag_value` fixture: RED
(`status=-50`, minima `3/4`) before, green after.  `make -k check` is green and
the 120-case fuzz reports 0 mismatches.

**Important correction to this ledger.**  With the Pareto gone the compiler
reaches the normalization-escape gate instead of aborting at `selection_limits`,
and reports:

```text
normalization-escape=542 at 0xffffffff812098b1..0xffffffff812098ca
live=0x7ffff (14092 -> 14092 bytes, 1033 node-delta), selected=788279/788279
```

The escape gate (stage 244) runs *after* the Pareto stage (235), so every
`normalization-escape=0` report in this file was masked by whichever Pareto
aborted the scan first; the kernel's escape population was never actually
zero at those checkpoints.  A control build that only makes the dense ALU
frame decline `0xffffffff815cde46` (leaving `publication_for_emission`
untouched) reports the identical `542`, confirming the population is
pre-existing and not caused by this change.  The real remaining kernel work is
therefore a 542-block normalization-escape population whose first witness is
`0xffffffff812098b1..0xffffffff812098ca`, not the next Pareto point.

The first escape (`__register_chrdev_region.cold`) is a coverage gap, not a
floor gap.  Its plan mixes ALU nodes with a register copy and two constants:

```text
N1 = ADD3[1](L2, L6, -1)   N2 = insert(0, N1, 32) -> L1
N3 = insert(0, L6, 32)  -> L2   N4 = xor(L8, L8) -> RFLAGS (L8 = projection(N4))
L6 = L14 (copy)   L7 = address constant   L9 = 0xfffff
```

`alu_frame_shape` accepts it, but the publication loop reaches
`selection->blocking_work = 0x500 | 1`: `operand_expression_bits` has no case
for `LANE{32,64}_INSERT`, so the zero-extension publication `N2` has no width
and the frame rejects.  A first attempt that made `operand_expression_bits`
return the insert width for every insert moved the failure back to native stage
228 (`0xffffffff8124b1dc`, `status=-49`): the frame then *attempted* insert
units it cannot emit and returned an error instead of declining.

The required work is therefore a real insert encoder, not a width probe: for
`insert(0, inner, 32)` the inner may be emitted at 32-bit width (a 32-bit
register write is the zero extension itself), while `width < 32` needs the
inner materialized in a register followed by `movzx`, and an unpublished inner
must be materializable at the insert's width.  All of this has to keep
measure/write byte-identical and stay total on the blocks that previously
declined (`0xffffffff8124b1dc`).  The copied source is the only offered
candidate today (work 6, span 1, `normalized_family_present=1` via the source
itself), so the escape gate is a work/coverage gate rather than the
`out->count == 0` predicate of the 2026-09-18 taxonomy.

First two entries of that population are closed.  `zero_extend_operand` returns
the inserted operand of `insert(0, inner, width)` whatever its kind, and the
dense ALU frame's publication loop materialises an inner value that has no
publication of its own at width 32 (the 32-bit register write is the zero
extension itself).  `collect_affine_lea_width` now also accepts a 64-bit `ADD3`
as a 32-bit address coordinate, because a 32-bit LEA is exactly the low word of
the 64-bit sum; both were needed before `0xffffffff812098b1`'s
`lea ecx,[rsi+rdx-1]` could be emitted.  `check/select-x86.c` gains a
`zero_extend_unpublished_inner` fixture (RED with `copied_source=1`, green
after).  The population drops **542 -> 534**.

The new first escape was `0xffffffff8120bc1c`
(`io_submit_fail_init.isra.0+0x4c`).  Its plan ends in a conditional select
`N6 = select(L6|0x100, (L6 & ~0x40)|0x800100, ZF)` whose flags come from
`N4 = X86_ALU and(L6, 0x40)`; `L6` itself is then overwritten by the constant
`0xffffff83`, so `N4`'s value has no publication and `alu_frame_shape` rejected
the block (`publication_owner(projection(N4)) >= GPR_COUNT`).  A flag-only
`X86_ALU` whose flags a conditional select consumes is a legal frame: the
select's compare path emits the tested operation directly, here
`test esi,0x40`, which has the same ZF as the source's `and esi,0x40` while the
dead `and` value is overwritten anyway.  `alu_frame_shape` no longer requires
the final flag `X86_ALU` to have a GPR value publication.  The block's
normalized candidate is `mov r8,rsi; bts r8,8; mov rcx,rsi; and rcx,-0x41;
or rcx,0x800100; test esi,0x40; cmove rcx,r8; mov esi,0xffffff83`
(span 4, work 8), verified equivalent to the source.  `check/select-x86.c`
gains a `flag_only_alu_select` fixture that requires a normalized production to
accept the shape (candidate count 1 -> 2): RED before, green after.  The
population drops **534 -> 533**; the new first escape is
`0xffffffff8120d4d2..0xffffffff8120d4d8` (`output=0x2 expected=0x1`).
`make -k check` and the 120-case fuzz are green.

`0xffffffff8120d4d2` (`io_sq_offload_create+0x162`) is two instructions,
`mov rdi,rbp; mov r14b,1`, and its plan is one node plus one copy:
`N1 = insert(L14,1,8) -> L14` and `L7 = L5`.  The frame declined with
`blocking_work = 0x500 | 14`: `in_place_lane_insert` only accepts a lane ALU
inner (opcodes 6..9 / 76..79), so a **constant** inner had no production.

A new `lane_constant_insert` recognises `insert(local, constant, 8|16)` with the
base equal to the published local, and `emit_lane_constant_move` writes the
constant into the low lane (`mov r14b,1`, `mov r14w,imm16`) preserving the rest.
Width 32 is deliberately excluded: a 32-bit move would also clear the base's
upper word, which the insert does not.  The block's normalized candidate is the
exact source `mov rdi,rbp; mov r14b,1` (span 1, work 2).  `check/select-x86.c`
gains a `lane_constant_write` fixture (RED `copied_source=1`, green after).
The escape population drops **533 -> 510**; the new first escape is
`0xffffffff812162e6..0xffffffff8121630b` (`output=0xb expected=0x8`).
`make -k check` and the 120-case fuzz are green.

`0xffffffff812162e6` (`calibrate_delay+0x256`) is a conditional block; the
seven-node plan is

```text
N1 = sub(L3, L0)   N2 = sub(L12, L1)   N3 = shr(N1, 4) -> L3
N4 = shr(N1, 1) -> L0   N5 = shr(N2, 1) -> L2
N6 = sub(N4, N5) -> L1  N7 = compare(L16, N6, N3) -> RFLAGS (jae)
```

and only the copied source was offered.  A probe reported
`blocking_work = 0x700`, `blocking_opcode = 0xb`, i.e.
`next_compare_branch_assignment_excluding(plan, pending = {L0,L1,L3},
preferred = {L1,L3}, deferred = 0)` found no legal next publication: `L0 = N4 =
shr(N1,1)` and `L3 = N3 = shr(N1,4)` share the root `N1 = sub(RBX,RAX)`, so
each reads the coordinate the other overwrites.

`shared_root_shift_handoff_shape` now recognises two pending publications that
shift the same unpublished root whose operands are exactly those two
destinations, and both compare-branch paths emit the root once (in place in one
destination), copy it to the other, then shift each once.  For this block the
candidate is

```text
sub rbx,rax; mov rax,rbx; shr rbx,4; shr rax,1; mov rdx,r12; sub rdx,rcx;
shr rdx,1; mov rcx,rax; sub rcx,rdx; cmp rcx,rbx; jae
```

(span 6, work 11, the source operations reordered), verified equivalent.
`check/select-x86.c` gains a `shared_root_shift` fixture (candidate count 1
before, 2 after).  The escape population drops **510 -> 509**; the new first
escape is `0xffffffff8121c47d..0xffffffff8121c48f` (`output=0x5 expected=0x4`).
`make -k check` and the 120-case fuzz are green.

`0xffffffff8121c47d` (`amd_pmu_v2_snapshot_branch_stack+0x1d`) is a wider
version of the same shared-root shape:

```text
N1 = shl(L2, 32)   N2 = or(L0, N1)   N3 = shr(N2, 32) -> L2
N4 = X86_ALU and(N2, ~0x40) -> L0 = projection(N4), and it is the flag producer
```

so the shared root `N2` is consumed by a masked `and` (the final flags) and a
`shr`, and it reaches both destinations *transitively* (`N1 = shl(L2,32)`), not
by naming them directly.  The dense ALU frame blocked with
`blocking_work = 0x200` (`next_alu_frame_assignment` finds no first
publication).

`shared_root_unary_handoff_shape` generalises `shared_root_shift_handoff` for
the dense ALU frame: it classifies a pending publication as a lane shift or an
architectural ALU pair over a constant (`shared_root_consumer_of`), requires
two consumers of the same unpublished root whose operand tree reads the entry
values of both destinations (`operand_gpr_sources`, so transitive reads count),
and emits the root once in the non-flag destination, copies it, applies that
consumer, then applies the flag-producing consumer last.  For this block the
candidate is the exact source
`shl rdx,0x20; or rdx,rax; mov rax,rdx; shr rdx,0x20; and rax,~0x40`
(span 3, work 5).  `check/select-x86.c` gains a `shared_root_unary` fixture
(candidate count 1 before, 2 after).  The escape population drops
**509 -> 507**; the new first escape is `0xffffffff8121c995..0xffffffff8121ca1c`
(`output=0x23 expected=0x1f`).  `make -k check` and the 120-case fuzz are
green.

`0xffffffff8121c995` (`amd_pmu_lbr_hw_config+0x15`) is a 32-node flag-selector
chain.  Its plan builds two constants from `L1` (RCX):

```text
N1 = L1 & 3
N4/N8/N12/N26 = select(constant, 0, test(L1 or L1>>8, bit))   (4 constant arms)
N5 = N1 | N4    N9 = N5 | N8    N13 = N9 | N12   ... OR-accumulation
N16..N23 add shifted bit-extracts of L1
N27 = N23 | N26
N28 = N27 | 0x40000 -> L2 (RDX)
N31 = N27 | ((L1 << 2) & 0x40000) -> L0 (RAX)
N32 = xor(L6, L6) -> L16 (flags), L6 = projection(N32) = 0
```

So the final `N27` is published twice (RDX and RAX) and `L6` is a dead-value
`xor esi,esi`, and changed = {L0, L2, L6}.  Only the copied source is offered
(work 35, SSA floor 31) and the dense ALU frame blocks at `blocking_work =
0x200`.  The deadlock is exact: `publication_owner(const 0)` names the zero
class `L6` (the final flag-producing `xor`), so `L0`/`L2` depend on `L6`, which
the flags-last rule schedules last.

Hand calculation, then landed.  The coupling is resolved by two narrow rules:

- `zero_self_flag_publication` recognises the owner of constant zero when it is
  a zero-producing self operation (`xor r,r` / `sub r,r`) that is also the final
  flag producer.  Both `operand_source_law` and `physicalize_published_operand`
  keep a constant zero an immediate for that owner, so a zero operand neither
  waits on nor reads the flag producer's coordinate.  (Only that owner is
  special-cased; other constant owners keep the existing substitution, which is
  why `condition-code-check` and the `in-place owner` fixture stay green.)
- `flag_value_preload` records the preloaded destination as its own entry source
  (`frame_sources[destination] |= 1<<destination`), so the coordinate stays out
  of every other publication's scratch pool until the final flag producer runs.
  Without it, `0xffffffff8124f4c1`'s wide `and` mask landed in the preload
  destination and the final `neg rax` negated the mask instead of `N2`.

Both are needed together: with them the Pareto stays cleared and the escape
population drops **507 -> 500** (`0xffffffff8121c995` still leads at
`output=0x23 expected=0x1f`).  `condition-code-check`, `make -k check` (79
targets) and the 120-case fuzz are green.

`0xffffffff8121c995`'s own remaining blocker is now the long chain and it is
exact.  The frame reaches `blocking_work = 0x280 | 2`: the publication
`L2 = N28 = N27 | 0x40000` is a `single_bit_or`, and measuring its seed `N27`
falls into the select `N26 = select(32772, 0, test(N17, 32))` where
`N17 = L1 >> 8`.  Instrumenting `measure_alu_tree` shows the select fails at the
final rejection with `remaining = 32` (so the recursion budget is not the
issue): the select's compare operand `N17` is an unpublished node, so the frame
seeds it into a scratch and needs a second scratch for the constant candidate
arm, while `alu_frame_scratch_mask` offers only one free coordinate.  The source
never materialises `N17`: it tests the high byte directly (`test ch, 0x20`).
The next step is to let the select compare map a shifted entry byte to its
high-byte coordinate (`test_byte_coordinate` / `emit_high8_test`) instead of
seeding the shift node, which removes the extra scratch and should let the
whole accumulation chain emit.

`test_byte_coordinate` already handles `bits == 8`, so that is not the gap.  The
real gap in the nested path was `measure_alu_tree` / `write_alu_tree`'s select
branch: a select with a **constant** candidate arm
(`candidate_immediate`, e.g. `select(32772, 0, test(...))`) left
`candidate_local == GPR_COUNT` and passed it to `emit_conditional_move`, so the
branch always failed.  Both nested branches now materialise the constant
candidate into a free scratch coordinate first, exactly like the outer
publication loop.  That closes one block (**500 -> 499**) with `make -k check`,
`condition-code-check` and the fuzz green.

`0xffffffff8121c995` itself still blocks at `0x280 | 2`, and the instrumented
rejection is now exact: `measure_alu_tree(dest = L2, node = N26,
scratch = 0)`.

Hand calculation of the whole block.  The source is one accumulation with two
coordinates: `RAX` is the accumulator and `RDX` the candidate.

```text
mov rax, rcx ; and eax, 3                     acc = ecx & 3
mov rdx, rax ; or rdx, 0x29ffc ; test cl,8  ; cmovne rax, rdx
mov rdx, rax ; or rdx, 0x8c54 ; test cl,10  ; cmovne rax, rdx
mov rdx, rax ; or dl, 0xa8    ; test cl,20  ; cmovne rax, rdx
mov rdx, rax ; or dh, 8       ; test cl,40  ; cmovne rax, rdx
mov rdx, rax ; or dh, 1       ; test ch,4   ; cmovne rax, rdx
mov rdx, rax ; or rdx, 0x20000; test ch,10  ; cmovne rax, rdx
mov rdx, rax ; or rdx, 0x8004 ; test ch,20  ; cmovne rax, rdx
mov rdx, rax ; or rdx, 0x40000; test ecx,0x10000 ; cmovne rax, rdx
xor esi, esi
```

The frame cannot express this because `L0 = N31 = select(N28, N27, cond)` has
`N28` as its candidate and `N28` is published to `L2`, so the law makes `L0`
depend on `L2`; the frame therefore publishes `L2 = N27 | 0x40000` first and
asks for the whole chain to be built into RDX, where no scratch is free for the
nested constant candidates.  In the source `N28` is not a separate
materialisation at all: `mov rdx,rax; or rdx,const` builds it inside `L0`'s own
publication, and `L2` is that same RDX.  So the fix is a handoff that publishes
the final select `L0` with its candidate **materialised into `L2`'s
coordinate**, which simultaneously satisfies `L2` (no `L0 -> L2` edge needed),
and accumulates the chain in `L0`'s coordinate with the candidate as the only
scratch.  That is the next production.

Measuring the population instead of only the first witness paid off: tallying
every counted escape by node count shows most of it is small, not long chains
(13 at 0 nodes, 69 at 1, 54 at 2, 76 at 3, 80 at 4, ...).  One whole class was a
normalized-argument-order bug: `standalone_flag_publication_details` read the
`bt` base from argument slot 2 and the offset from slot 1, but the physical
rewriter hands over `(prior, base, offset, bits)` (a register base in slot 1, an
immediate offset in slot 2) for `bt reg,imm`.  It therefore rejected every such
block with `blocking_work = 0xf003`.  Resolving the base to whichever slot holds
the register closes **12 blocks (499 -> 487)**.  `check/select-x86.c` gains a
`bit_test_constant_offset` fixture (candidate count 1 before, 2 after);
`make -k check`, `condition-code-check` and the fuzz are green.

The next class is the flag-value preload with a bare **entry register** as the
value tree.  For `0xffffffff8123e543` (`mov rax,rdx; shr rdx,32; or rax,0x1e`)
the final flag producer is `or(entry RDX, 0x1e)` while `L2 = shr(entry RDX,32)`
overwrites RDX, so the entry must be copied into the flag destination before
the clobber.  `flag_value_preload_shape` swapped away from a non-node tree and
rejected it, so the frame offered nothing.  Keeping the tree when it is an
entry local with an immediate `other` (preload = one copy, then the immediate
operation last) closes **7 more blocks (487 -> 480)**; the normalized candidate
is `mov rax,rdx; mov rdx,rax; shr rdx,0x20; or al,0x1e` (span 2, work 4) and
the copied source's `3` work stays the joint minimum.
`check/select-x86.c` gains a `preload_entry_register` fixture (candidate count 1
before, 2 after).  `make -k check` and the 120-case fuzz are green.

The remaining 480 escapes are now classified by the first rejection recorded in
`pl_x86_select_candidates` (the diagnostic for blocks with no normalized
candidate):

| `blocking_work` | blocks | meaning |
| --- | --- | --- |
| `0x200`/`0x202` | 78 + 24 | dense-ALU scheduler deadlock (shared roots) |
| `0xf002` | 51 | `alu_frame_shape` rejected the block |
| `0xf003` | 49 | final flag node is neither a value nor a known standalone flag |
| `0xf001` | 31 | block kind/flow/dynamic/machine outside the ALU frame |
| `0x0` | 28 | a production returned 0 without recording a rejection |
| `0x501`/`0x201`/`0x500`/... | 22+13+9+... | per-publication encoder gaps |

Sampled shapes: `0xf002` includes `and edx,7; xor eax,eax; cmp dl,6; sete al`
(a `setcc` boolean, plan `L0 = condition(cmp)`, `N4 = test(L0,L0)`) and
`cmp $1,rbp; mov rdx,rbp; mov rdi,r12; mov esi,2` (compare plus copies and a
constant).  `0xf003` includes `and eax,0xffffc0; cmp eax,0x20f00; mov eax,0;
je` and blocks whose value tree mixes `and`/`or` with a wide `movabs`.  These
are separate per-shape productions; the `setcc` boolean and the constant/copy
blocks are the most regular and are the recommended next targets.

The `setcc` class is now exact.  `0xffffffff812497b9` (`and edx,7; cmp dl,6;
sete al`) has selection plan `N1 = and(L2,7)`, `N2 = compare(L16,N1,6)` with
`L0 = projection(N2, selector 4)` (the ZF boolean), `L2 = N1`, `L16 = N2`.
`alu_frame_shape` rejects it because the projection check requires selector 16
(the ALU value projection) and `4 != 16`.  Relaxing that check to accept
selectors 0..16 makes the shape accept, but the projection emission branch then
calls `alu_node_details`, which requires an `X86_ALU` node while `N2` is an
`X86_COMPARE`, so the frame blocks at `0x100 | 0`.  The missing piece is a
`setcc` production: a published flag-selector projection of a `COMPARE`/`TEST`
must emit the comparison (or test) and then `setcc` into the destination.  The
relaxation alone changes nothing and was reverted; a production is required.
The same `0x100` blocker covers the `cmp`+copy+constant blocks.

The largest `0x200` sub-shape is a select over a published constant that
clobbers its own current arm.  `0xffffffff8128ffa1` and `0xffffffff81290e50`
share it:

```text
mov rsi, rax      ; current = entry RAX
mov eax, 0        ; candidate = const 0 published to RAX (= L0)
cmovs rsi, rax    ; L6 = select(0, entry RAX, entry SF)
```

The plan is `N1 = condition(entry RFLAGS, 8)`, `N2 = select(0, L0, N1) -> L6`,
`L0 = const 0`.  `conditional_select_details_inner` binds the constant candidate
to its publication (`first_physical`, `candidate_local = L0`), so the law makes
`L6` depend on `L0`; but `L6`'s current reads entry `RAX`, which `L0`'s
publication overwrites, so `L0` must wait for `L6` -- a cycle.  The source
breaks it by copying the current into the destination first, then materialising
the constant into the same coordinate, then the `cmov`.  A sound fix is to let
this select take the `candidate_immediate` path (materialise the constant
instead of reading its publication) and preload the current before the constant
lands -- i.e. the select-current analogue of `flag_value_preload`.

Implemented.  `conditional_select_details_inner` now takes the immediate
candidate path when the condition is the entry flag word (no compare), the
candidate arm is a constant, and the candidate's publication owner is exactly
the entry register its current arm reads.  It records that owner in
`candidate_owner`, and `apply_select_candidate_laws` drops the resulting
spurious publication dependency from the frame law before scheduling, so the
select is free to run first.  The publication loop already evaluates the current
arm before the candidate, so the current lands in the destination before the
constant is materialised: the `flag_value_preload` order without a separate
pre-pass.  For the witness the frame offers `mov rsi,rax; mov eax,0; cmovs
rsi,rax; mov eax,0` (span 2, work 4); the constant is materialised into its own
publication's coordinate (RAX), which the separate `L0` publication then
repeats, so the copied source's `3/2` stays the joint minimum and is selected.
The block is nevertheless covered by a normalized production, so the escape gate
clears.

`check/select-x86.c` gains a `select_over_published_constant` fixture
(candidate count 1 -> 2, joint minimum span/work 2/3): RED (`candidates=1`,
`diagnostic=0x200`) before, green after.  Restricting the immediate path to the
entry-flag condition is what keeps `compare-cut` green: a select with a compare
resolves the same register conflict through the existing shared-flag handoff at
`5/2`, and forcing the immediate path there loses that spelling.  `make -k
check` is green (79 targets).  The two named kernel witnesses share this shape,
so the population is expected to drop 480 -> 478; the whole-kernel scan was not
rerun here because no linked kernel input is present on this host.

The `0x100`/`setcc` blocker is now closed.  `alu_frame_shape` accepts condition
projections (selector `0..15`), and a new `compare_boolean_group_shape` plus the
existing `emit_group_booleans` makes the ALU frame emit a `CMP`/`TEST` together
with its `SETcc` observations.  For `0xffffffff812497b9`
(`and edx,7; xor eax,eax; cmp dl,6; sete al`) the frame now emits exactly those
four bytes (span 3, work 4); `check/select-x86.c` gains a
`compare_boolean_observation` fixture (candidate count 1 -> 2, `0xf002` before,
green after; the isolated fixture must use the kernel's `0x7ffff` live mask or
the plan differs).  Only the case where the comparison is the block's final flag
producer is handled, so the group's comparison and the final flag publication are
the same instruction and `standalone_flags_pending` is cleared when the group
fires.  Whole-kernel scan: escapes **476 -> 465**, all `make -k check` targets
green, differential fuzz 120/0.

### The `0xf003` compare-over-an-unpublished-tree class (49 blocks, 2 closed)

`0xffffffff81249696` (`and eax,0xffffc0; cmp eax,0x20f00; mov eax,0`) has plan
`N1 = lane32.and(entry EAX, 0xffffc0)`, `N2 = compare(RFLAGS, N1, 0x20f00)`,
`L0 = const 0`, with `final_flag_node = N2`.  `standalone_flag_publication_details`
declined because the compare's left operand is the *unpublished* node `N1`
(`publication_owner(N1) == GPR_COUNT`, because the `and`'s only reader is the
compare and the later `mov eax,0` overwrites EAX), so `physical_left` was not a
local and the shape returned 0.

`compare_tree_flag_shape` + the ALU frame now materialize that operand tree into
a scratch and emit the comparison: the scratch is chosen from
`alu_frame_scratch_mask` (a register the frame will republish anyway, never an
unchanged live-out entry), the tree's published owners must be ready, and the
tree's entry sources must not be clobbered before it runs.  Two guards are
essential: 8-bit compares stay with `standalone_flag_publication_details`
(`test_byte_coordinate` owns the high-byte rewrite), and if the shape is
accepted but the tree cannot actually be measured the frame must decline
(post-loop `has_compare_tree` check) or it emits a stale-flag candidate -- the
first draft silently miscompiled `linked-field-authority-check` that way.

Only 2 of the 49 fire, so the remaining 47 have a different shape (the scratch
pool is empty, the tree needs a scratch of its own, or the operand is not the
first argument).  `check/select-x86.c` gains `compare_over_unpublished_tree`
(candidate count 1 -> 2, `0xf003` before, green after).  Whole-kernel scan:
escapes 465 -> 463.

### The `0xf001` indirect-dispatch class (31 blocks, closed)

Tail dispatches (`mov edx,1; mov esi,0xec; xor edi,edi; jmp *rax`) were rejected
by the ALU frame's `block->dynamic_target` guard, and `measure_direct_frame`
only accepted them when the plan had no nodes.  The ALU frame guard now accepts
`flow == JUMP && dynamic_target && successor_count == 0` and the tail emits
`jmp *target` via `emit_indirect_jump`, with the target resolved through
`published_operand_local`.  Blocks carrying `construction_fields` (an absolute
source relocation the frame cannot express) stay rejected -- without that
exclusion `code-grid-check` failed on the fixed-stride entry grid with an
unresolved relocation.  Whole-kernel scan: escapes **463 -> 432** (all 31);
`check/select-x86.c` gains `indirect_dispatch` (count 1 -> 2, `0xf001` before,
green after).  `make -k check` green (79), differential fuzz 120/0.

### The `0xf002` residual (28 -> 21 blocks)

The comparison-carry blocker is closed.  `81234414`
(`cmp rbp,1; ...; mov esi,2; adc esi,0`) and `812498b2`
(`cmp eax,1; ...; sbb ebx,ebx`) have `N2 = X86_ALU(N1, const, const, desc)`
with `arguments[0] == N1` (the compare), which `alu_node_semantics` rejected
because it requires the `RFLAGS` local.  `alu_carry_prior_node` admits the node
in `alu_frame_shape`, and `carry_alu_group_shape` emits the comparison (via
`emit_flag_coordinate`) and then the `adc`/`sbb` (via `measure_alu_pair` /
`write_alu_pair`).  The left operand materialization is a `mov` (flag
preserving), so the comparison's carry is still live at the `adc`.  The group
only fires when the comparison has no other pending Boolean consumer and none
of its physical operands is still pending.  Escapes 432 -> 425.

The Boolean-group blocker is also closed.  `8127fa0e`/`8128325d`
(`xor ecx,ecx; sub rax,rdx; setb cl; neg rdx; jns`) publish an `X86_ALU`'s value
projection AND a carry Boolean of the same node; the compare-branch frames
already ran `flag_result_group_shape`, but the ALU frame did not, so the
scheduler deadlocked.  The ALU frame now runs the same group (emit the
instruction plus its SETcc observations between the pre-zero and post-setcc
passes).  Escapes 425 -> 418.

Remaining `0xf002`: `8128be22` is `sete` over two chained compares;
`8121f647` a shift-with-flags; `81258eae` a `bsf`+`add`+`je`.  Whole numbers:
`0x200` ~68, `0xf003` ~47, `0x0` 28, `0x202` 24, `0x501` 22, `0xf002` ~14.

### The `0x500` narrow-zero-extension family (25 blocks)

`8121e2bc` (`mov rcx,rdx; shr rcx,0x20; movzx ecx,cx`) has
`N1 = lane64.shr(L2, 32)` and `N3 = lane64.insert(0, N1, 16)`, with `N1` never
published.  The ALU frame handled `insert(0, inner, 32)` (materialising the
inner at 32-bit width is itself the zero extension) but the 8/16-bit lanes fell
through to `operand_expression_bits`, which returns 0 for an insert, so the
projection emission blocked at `0x500 | local`.  The frame now materializes the
inner at its own expression width and emits `MOVZX local, local<lane>`; MOVZX
preserves the shift's flags, so the final flag node stays the shift.  Whole-kernel
scan: escapes **418 -> 393**.

### Current escape population (393) and the next exact blockers

Measured distribution after the narrow-zero-extension fix: `0x200` 75,
`0xf003` 44, `0x0` 28, `0x202` 24, `0xf002` 20, `0x800` 14, `0x201` 13,
`0x206` 12, `0x601` 12, `0x700` 11, `0xf100` 9, `0x802` 8, `0x502` 7,
`0x602` 7.

- `0xf003` by final-flag opcode: `X86_FLAGS` (183) 13, `SHIFT_FLAGS` (193) 9,
  `COMPARE` (191) 8, `X86_ALU` (203) 7, `TEST` (195) 5, `BIT_FLAGS` (197) 2.
  The 191/195 ones are the compare-tree shape with a *flag-clobbering sibling*:
  `812b4199` is `and eax,7; cmp eax,3; sete; select` where the tree reads entry
  EAX while a pending `const 0` also overwrites EAX.  `compare_tree_flag_shape`
  rejects because `!immediate && (sources & changed)`: with a clobbering sibling
  pending the group cannot fire before the constant, so the entry read would be
  lost.  Relaxing this needs the group to run before the source-overwriter
  without letting a clobberer run after the comparison.  The 183 ones
  (`X86_FLAGS` wrappers, `or edi,imm; movslq`) are partly closed:
  `publication_is_flag_result` now walks through a sign-extension of the flag
  result (`publication_is_flag_result` gained a `sign_extend_value` step beside
  the lane-and/insert steps), so MOVSX/Q keeps the flag provenance and the
  frame emits the value publication.  Escapes 376 -> 369.
- `0x502` closed.  `insert(base==dest, condition, 8)` (`setne dl` into a live
  RDX) is emitted by `in_place_condition_insert` as `emit_set_condition`; the
  base's upper bits survive, which is the insert semantics.  It is restricted
  to a condition whose flags operand is the entry `RFLAGS` local, so the SETcc
  can be ordered before every in-block flag writer; an in-block producer
  (`test edi,edi; setne r12b` in `8124ce85`) needs its own edge and was a
  Pareto witness when the branch first accepted it.  `next_alu_frame_assignment`
  now keeps a flag-reader as a blocker of the final flag producer
  (`publication_reads_entry_flags`), so the SETcc lands first.  Escapes
  386 -> 376.
- `0x800` large-constant add: `81249d91` folds a large constant into an
  in-place add (`N1 = ADD(entry EAX, 0x31FFFFFFFFFFF)`).  `measure_alu_pair` /
  `write_alu_pair` returned from the immediate fast path without trying the
  scratch path, so the add had no encoding.  They now fall through for a
  CONST right that the immediate form rejects; the scratch path materializes it
  into the pending `RDX` publication and reuses the folded `-1` displacement,
  emitting exactly the source (`movabs rdx,0x32000000000000; lea
  -0x1(%rax,%rdx),%rax; cmp; jb`).  Escapes 393 -> 386.  NOTE: the isolated
  `candidates_projected` harness cannot reproduce this block -- it does not
  fold a same-block `movabs` into the ALU node, so the `count` stays >= 2 with
  or without the fix.  Regression coverage for this one is the whole-kernel
  scan (7 blocks) plus `make -k check`/fuzz for no regression; no fixture.
  `81232239` (an `ADD3` carry chain) shares the failure and is not yet fixed.
- `0x200`/`0x202`/`0x201`/`0x206` remain dense-ALU shared-root handoffs; each
  sampled block has a different root pair.

### Rejected: standalone `SHIFT_FLAGS` in place (miscompile)

A first attempt let `standalone_flag_publication_details` emit a
`X86_SHIFT_FLAGS` whose value result is dead as `emit_shift_instruction(left,
amount, ...)` in place.  For `81219fe3` (`mov rdx,rbx; shr rdx,0x20`) that
produced the work-1 candidate `shr rbx,0x20`, destroying entry RBX, which the
source explicitly preserves by copying to RDX first.  `make -k check` and the
fuzz stayed green (no fixture covers it) and the Pareto gate cannot see a
*work-better* wrong arm, so this was a silent miscompile; it was reverted.  The
shape is only safe with a liveness check (shift into a register the frame
republishes, or copy to a scratch); the standalone emitter has no scratch, so
the production needs the copy form.  Only 1 of the 9 `SHIFT_FLAGS` blocks was
closed by it anyway.

## Current work: 2026-09-20 (flag-producer scheduling; make check green)

The native ALU frame could publish a value addition *after* the final flag
producer while still classifying the addition as flag-preserving. That is only
true when the emitter spells the addition with `LEA`; an addition whose operand
tree contains a flag-clobbering instruction (a product, a shift, a subtract) is
materialized with an ordinary `add`/`adc`. `frame_local_publication_clobbers_flags`
inspected only the publication's root opcode, so a `sub` flag producer followed
by an independent `imul`+`add` value tree was emitted as `sub; imul; add; jne`
and the terminal `jne` read the `add` flags. On a real dynamic PIE loop this
never terminates; the compiler and `postlink-verify` were both green, so the
miscompile was silent.

`frame_local_emission_clobbers_flags` now walks the whole operand tree: a node
already published in another local is a register read and stops the walk, while
a node materialized as part of this publication contributes its instruction.
`next_alu_frame_assignment` and both standalone-flag `clobberers` loops use it,
so the clobbering tree is scheduled before the flag producer. A
`flag_producer_after_clobbering_add` fixture in `select-x86-check` asserts the
emitted order (`imul; add; sub; jne`), not only the byte count; disabling the
walk reproduces the `sub`-first order. `make -k check` is green and the dynamic
fixture now runs identically to its source.

Two adjacent environment/initialization defects are fixed with it. `clear_block`
now initializes `relax_short_control` to its canonical short-control default, so
a caller that lowers a block without a layout pass gets a defined spelling; this
removed the `select-x86-check` preserved-flag prefix-branch red. Freestanding
`-nostdlib` fixtures build with `-fno-stack-protector`, because the host
compiler's default `-fstack-protector-strong` otherwise injects a
`__stack_chk_fail` reference the fixture cannot resolve.

The remaining reds are the four normalization-escape witnesses
(`0x4083ba 0x419718 0x44792e 0x4170ca`), the static-glibc Pareto witness
`0x41bb01` (the kernel witness `0xffffffff81397304` is resolved below), the
`0xffffffff813a13c4` measure/write divergence it exposes, the measured
performance gate, Artifact/Storage/Wasm, and the distribution boot.

### Pareto witness resolved: lane identity mask (2026-09-20)

`lane{32,64}.and(x, all_ones)` is the identity on the lane, and a lane-width
publication's own register move already zero-extends, so the ALU frame's
redundant mask is dropped by `lane_identity_mask_details` in `select-x86.c`
(measure and write).  The kernel witness `0xffffffff81397304` moves from
`2/6/24` to `2/5/21`, which attains both minima and dominates the source
`3/5/22`, so it no longer returns `PL_ERROR_X86_PARETO`.  The next witness,
`0xffffffff813a13c4`, is a pre-existing ALU-frame measure/write divergence.

## Current work: 2026-09-18 (working tree; make check green)

Both broad selector regressions are resolved and the complete native `make
check` is green again.

The normalized single-bit projection is emitted as a bit test plus a
conditional move. `zero_flag_frame` carries at most one projection value, and
its measure and write paths emit `xor r,r; test lane,input-bit; cmovcc
r,output-bit`, so the former `mov; shl; and; xor` chain loses its mandatory
entry copy and reaches the source span. `shared-expression-check` is green:
1,511,424 source/generated/reference comparisons and zero former bit-projection
frontiers (77 -> 0).

Expression cut 17 (the GNU make jhash interval) now selects a generated
spelling. A new shared-DAG frame re-associates every `ADD3(a,b,c)` whose two
operands are already an earlier binary `ADD`, schedules each node once into an
overwritten output register with bounded backtracking and farthest-next-use
spilling, and replays through transient value aliases. The generated body has
work 39, matching the previous source-only bound, so the fixture selects a
normalized candidate.

Fixing cut 17 also exposed a third, previously masked pre-existing failure:
`stable_predicate_source_jump` expected the ordinary ALU frame, but its `stc`
left the `TEST` prior flag word as an intermediate node and the frame rejected
it. `flags_root_only_arithmetic` now proves that such an intermediate only
perturbs flags the `CMP`/`TEST` overwrites (lane `AND`/`OR`/`XOR` immediates
whose mask cannot touch a preserved lane, terminating at entry RFLAGS), so the
intermediate is dropped and the frame matches. `select-x86-check` is green.

All checker targets and the full `make -k check` now exit zero on the native
host.

Post-linking real ELFs now completes end to end. An ordinary PIE first stopped
at a 29-byte block:

```sh
cc -O2 -Wl,--emit-relocs hello.c -o hello.elf
src/v2/postlink-compiler/build/postlink-compiler hello.elf -o hello.opt
# was: native stage 244 at 0x1065 -> 0x1082; output=0x8 expected=0x7
```

`stage 244` was the normalization-escape gate. The block
(`mov ebx,edi; lea rsi,[rip+d]; xor eax,eax; shr ebx,13; xor ebx,edi;
mov edi,2; imul ebx,ebx,imm; mov edx,ebx`) had one failing production,
`measure_direct_alu_frame` at blocking work `0xf003`: its final flag node is
`PL_OPCODE_X86_MUL_FLAGS`, and `flag_value_operation_details` /
`publication_is_flag_result` only related `X86_FLAGS`/ALU/COMPARE/TEST to a
value publication. `mul_flags_value_publication` now relates the flags node's
64-bit low product to a `MULR`/`LANE32_MULR` value over the same multiplicands
(the narrow constant is the low 32 bits of the wide one), so the emitted IMUL
is accepted as the final flag producer.

Both real programs now compile, prove and run:

```text
hello.elf  17800 -> 13824 bytes   0 normalization escapes   proof 9 -> 8 work, 9 -> 4 span
primes.elf 18344 -> 13824 bytes   0 normalization escapes   proof 9 -> 5 work, 9 -> 4 span
```

`native-benchmark` completes 401 paired samples with matching output and exit
state on the same identities.

Static non-PIE admission is now open. A `-static` image carries symbol-free
IRELATIVE rows in `.rela.plt` (`sh_link == 0`) that patch the GOT; the readers
rejected them before checking whether the relocation target was executable.
`pl_elf_code_relocation_population`, `collect_relocation_targets` and
`metadata.c`'s `walk_lazy` now skip a RELA section whose `sh_link` is absent or
not a symbol table. A second normalizer gap was generalized at the same time:
two `ADD3` word sums over the same two variables but different constants now
recover the earlier base sum, so `lea rbx,[rbx+rcx-0x940]` followed by
`lea rdi,[rbx+8]` shares one three-term tree instead of rebuilding it.

The static glibc binary now reaches native closure: 40,566 selected blocks, 29
normalization escapes and 4 preserved non-image control edges. Two classes
closed by hand calculation:

- `measure_direct_consumed_flag_frame`: `sub rcx,rdx` produces the final
  observable flags while its result is consumed by a later `lea` rather than
  published. Emit independent publications, then the flag-producing ALU, then
  only affine/copy publications over that result (LEA/MOV preserve the
  arithmetic flags). Closes `0x4045c0..0x4045d7`.
- `measure_direct_transient_seed_frame`: the final `X86_ALU` producer has an
  operand intermediate that reads an entry clobbered by another publication.
  Capture the intermediate once in a transient output coordinate whose final
  publication is flag-preserving, run the other publications, emit the flag
  producer, then close the transient. Closes `0x407d0e..0x407d1d`.

Both emissions still need dedicated executable regressions: the real static
closure is not yet complete, so their proofs have not been exercised on a real
input. The next escape is `0x4083ba..0x4083d9` (work 8 versus floor 7). The 4
non-image control edges remain the separate
barrier classification.

### Static escape taxonomy (2026-09-18 working tree)

`postlink-compiler /tmp/hello-static.elf` reports 29 normalization escapes.
Every one is a `copied_source` selection with `source_identity == 0`. Breaking
at the escape counter enumerates the whole population; the shapes sort into
seven classes:

| class | addresses | blocks |
| --- | --- | --- |
| futex/`syscall` prologue | `0x42da61 0x42dcbc 0x42dfcc 0x42e134 0x42e187 0x42e1f9 0x42e264 0x42e4bc 0x42e4e6 0x42e637 0x463a00 0x484313 0x4844b5 0x4845f0 0x4846b0 0x484800 0x48491d 0x485aa7` | 18 |
| `div`/`idiv` with a broadcast dividend | `0x419718 0x441bc7` | 2 |
| `cmovcc` + address constant | `0x4170ca 0x44792e` | 2 |
| `bt reg,imm64` + `movabs` | `0x454036 0x454124` | 2 |
| `bswap` + zero-extension | `0x4540e1 0x45542c` | 2 |
| variable shift by a masked count | `0x415863 0x47cc7c` | 2 |
| `setcc` boolean publish | `0x4083ba` | 1 |

The escape predicate is not a floor comparison first.  In
`pl_x86_select_candidates` the copied-source candidate sets
`normalized_family_present = out->count != 0 || block->live_output_mask !=
all_outputs`.  Every one of the 29 has the full live mask (`0x7ffff`) and
`out->count == 0`, so **no normalized grammar production accepted the block**;
the `normalized_work_floor` comparison is only the second conjunct.  The
population is a frame-coverage population, not a plan/floor accounting one.

A small probe (lower one address with
`pl_x86_block_lower_projected_until`, then call `pl_x86_select_candidates`
directly and read `candidates.diagnostic`) reports each block's first recorded
rejection:

| `blocking_work` | meaning | blocks |
| --- | --- | --- |
| `0xf003` | `measure_direct_alu_frame`: the final flag node is neither a value publication nor a recognized standalone flag; or, at `measure_direct_live_frame`, nothing is dead so no instruction may be dropped | 14 |
| `0x500 or local` | a pending publication's value has no expression width and no affine/extend/insert encoder (`LANE64_INSERT` for `xor sil,imm`, `LANE64_SELECT` for `cmovcc`) | 7 |
| `0x200 or first` | the ALU frame scheduler has no assignment for the first pending local | 2 |
| other `0x1xx`-`0x6xx` | first failing publication form (div, bswap, shift, setcc) | 6 |

The 12 futex prologues dominate: `xor sil,0x81` is a byte-lane `X86_ALU`
whose value is consumed by a `LANE64_INSERT`, so
`flag_node_has_value_publication` never observes the publication and
`standalone_flag_publication_details` does not describe byte-lane flags.  The
last-resort `shared_dag_shape_build` rejects the same blocks one step earlier:
it requires every live publication to be a distinct node, and these blocks also
publish constants (`mov eax,0xca`) and register copies.

Closing the population means extending the direct ALU encoder (or the
shared-DAG last resort) so that (a) a widened byte-lane flag result is seen as
published, and (b) a live-out constant or copy is materialized as a scheduled
final publication.  Both are coverage changes; the escape predicate and the
work floor are untouched.

The `0xf003` shape is now exact.  For `0x42da61` the plan is
`n1 = and(RSI, 0x80)`, `n2 = xor(n1, 0x81)`,
`n3 = X86_FLAGS(prior, n1, .., n2, descriptor)`, `n4 = and64(n2, 255)`,
with `RSI(local 6) = n4` and `RFLAGS(local 16) = n3`.
Lowering known instructions with a small mapper identifies the physical
vocabulary exactly: `lane32.and = 6`, `lane32.or = 7`, `lane32.xor = 8`,
`lane64.opcode = 70 + lane32 index`, so the publication `n4` is
`lane64.and(n2, 255)`.  `flag_result_operand(n3)` returns `n2`, but `RSI`'s
publication is `n4`, a low-lane mask of `n2`, so `publication_is_flag_result`
never reaches the flag result and `standalone_flag_publication_details` only
knows `TEST`/`COMPARE`.

The same-source `0x42e134` variant keeps the insert explicitly:
`n1 = insert(0, EBX, 32)`, `n2 = xor(EBX, 0x81)`,
`n4 = insert(n1, n2, 8)`, `RSI = n4`.  Here the publication needs two emitted
instructions (`mov esi,ebx` then the byte `xor sil,0x81`), not one.

A previous attempt to recognize a direct `{NODE, flag_node}` publication and to
unwrap an in-place `LANE64_INSERT` left the count at 29 and was reverted.  A
low-lane mask unwrap is not a safe one-liner either: the physical rewriter turns
every `X86_ALU` lane form into `lane{32,64}.and/or/xor`, so a bare
`lane64.and(x, 255)` does not by itself prove the masked bits are zero.  Closing
this class needs a production that carries the redundancy proof (the fold from
`insert(zero-upper base, value, width)` where the base's upper bits are known
zero), emits the value producer in place, and, for the explicit-insert variant,
also emits the base materialization.  The escape predicate and the work floor
are untouched.

First such rule landed: `publication_is_flag_result` now propagates the flag
provenance through a low-lane `lane{32,64}.and` mask (opcodes 6 and 76 with a
constant second operand).  The mask is a value-widening artifact of the
physical rewriter and has no flag effect in the plan (the block's RFLAGS names
the original producer), while the emitter still materializes the mask itself,
so the rule stays sound even for a genuine `and reg,mask`.  This closes
`0x42da61` (`count` 1 -> 2, a normalized candidate at work 7) and drops the
static population to 28.

The remaining futex blocks are the explicit-insert variant.  With
`flag_operation_details` temporarily relaxed to admit a sub-32 `X86_FLAGS`
descriptor (bits 8), `0x42e134` moves from the `0xf003` standalone-flag
rejection to `0x260 | local`: the ordinary flag branch is reached but
`measure_alu_pair(destination=6, bits=8, mode=xor)` returns 0, verified under
gdb.  The relaxation was reverted because it closed no block while widening a
core predicate; the next wall is a byte-lane ALU emission path (`measure_alu_pair`
at bits 8/16) or a dedicated byte-lane flag production.

### Byte-lane closure (2026-09-18, second pass)

Three changes close the whole byte-lane class, dropping the population 28 -> 17
(node-delta 49 -> 30):

- `emit_alu_instruction` now admits bits 8 and 16 and delegates to a narrow
  encoder that mirrors the compare/flag emitters: 8-bit opcode table, `0x80 /n
  ib` / `0x66 0x83|0x81` immediates, the mandatory REX for SPL/BPL/SIL/DIL, and
  the `0x66` operand-size prefix.  The 32/64-bit path is unchanged.
- `flag_operation_details` admits a sub-32 `X86_FLAGS` descriptor (its old
  `bits < 32` guard is removed; the descriptor-matches-bits check already pins
  the width).
- `publication_is_flag_result` carries the flag provenance through a low-lane
  `lane{32,64}.and` mask (6/76) and through a `lane{32,64}.insert` (198/201),
  and `publication_for_emission` rewrites an insert publication of the final
  flag result to the inserted value so the ordinary flag branch emits it (base
  tree included).

`select-x86-check` is green after the change.  The remaining 17 are single
witnesses per shape: `0x200 0x201 0x500 0x503 0x506 0x507 0x509 0x600` plus the
two `bt` blocks at `0xf003`.

### In-place lane insert (third pass) and current population

`in_place_lane_insert` recognises `insert(base = the published local, value,
width)` and emits `value` at the insert's width into the base, closing
`0x4846b0 0x42dcbc` and their `0x503`/`0x509` relatives.  The rule is limited to
the measured lane ALU opcodes 6/7/8/9 and 76/77/78/79: on a non-ALU inserted
node (e.g. `X86_CONDITION` at `0x40192a`) `measure_alu_tree` returns
`PL_ERROR_X86_SELECT`, so an unrestricted rule aborted the whole selection;
restricting to lane ALU keeps the rule total.

Population is now **12**: `0x200` (3), `0x201` (2), `0x500` (2), `0x506` (1),
`0x507` (1), `0x600` (1), and the two `bt` blocks at `0xf003`.  All checks
remain green.

### The `0x200` scheduler deadlock (exact)

gdb (an `-O0` build, because `-O2` elides the diagnostic) gives the failing
state for `0x441bc7` (`lea rsi,[rdx+rax]; sub rax,r9; xor edx,edx; sub rsi,rcx;
mov rcx,rax`, terminal before `div`):

```
pending = {L0,L1,L2,L6}   final_flag_node = 3
L0 pub=NODE2    src=0x201 dep=0     (RAX = node2)
L1 pub=NODE2    src=0     dep=0x1   (RCX = a copy of L0)
L2 pub=CONST 0  src=0     dep=0     (RDX = 0)
L6 pub=PROJ(3)  src=0x7   dep=0     (RSI = the final flag producer)
```

The flag producer `sub rsi,rcx` must be textually last to own the flags, but
its value tree `node1 = rdx+rax` reads entry `RAX`, which `L0` overwrites, and
its right operand `RCX` is overwritten by `L1`.  The scheduler's
`frame_local_publication_clobbers_flags` already treats `L1` (a copy whose
owner is `L0`) as flag-preserving, so only `L0` remains a blocker; but `L0` is
itself skipped because `L6`'s sources read entry `RAX`.  The two are circular.

The block is schedulable by splitting the flag producer: evaluate its value
tree into the destination first (`lea rsi,[rdx+rax]`), run the flag-clobbering
publications (`sub rax,r9`, `xor edx,edx`), then the flag operation
(`sub rsi,rcx`), then the flag-preserving copy (`mov rcx,rax`).  No scratch is
needed because the destination is not read by any other pending publication.
The remaining `0x200`/`0x201` witnesses share this shape; the production is a
reschedule that pre-computes the flag producer's value tree and defers only its
flag-setting instruction, with a transient capture when a flag-clobbering
publication (rather than a copy) overwrites the other operand.

That reschedule landed as `flag_value_preload_shape` plus a pre-pass in both
`measure_direct_alu_frame` and `write_direct_alu_frame`.  The write path reuses
the alias recorded by measure (it is carried in the candidate selection), and
clears it only while re-emitting the preloaded tree, so
`derive_emitted_candidate_cost` sees identical bytes.  This closes `0x441bc7`
and drops the population to **11**; all checks remain green.

`0x200`/`0x201` are not uniform.  The scheduler deadlock above is one shape;
`0x4083ba` fails instead in the projection branch's `measure_alu_pair`, and
`0x44792e` has both flag operands as entry locals (`R13 op R12`), where the
value tree is empty and the pre-pass does not apply.  Those need their own
rules.

### Remaining 8 (2026-09-18, aiming at zero)

Two more general rules landed:

- `operand_expression_bits` reports the width of `lane32/64.bswap`, and the
  publication loop gains a bswap branch that emits `0F C8+rd` (with REX.W for
  the 64-bit form) after materializing its source; the write path mirrors it.
  Closes `0x45542c` (11 -> 10).
- `standalone_flag_publication_details` now also recognises
  `X86_BIT_FLAGS` (`bt`): the base is the third argument, the bit offset the
  second (a register constant owner or an imm8), and the width the fourth.
  `emit_bit_test_register` emits `0F A3 /r` or `0F BA /4 ib`.  Closes
  `0x454036` and `0x454124` (10 -> 8).

Population is **8**, all single witnesses:

- `0x415863 0x47cc7c` (variable shift): the count is not the simple
  `and(entry, mask)` that `shift_node_details` expects, but a chain such as
  `and(RCX,7) << 2` then `and(_,31)`.
- `0x4170ca` (`lane64.select` publication): `conditional_select_details` does
  not match the cmov shape here, so the generic width probe returns 0.
- `0x463a00` (`mul` of an inserted value): publication `n6 = lane32.mul`.
- `0x44792e` in-place ALU whose two flag operands are entry locals.
- `0x4083ba 0x419718` projection `measure_alu_pair` failure.
- `0x4540e1` scheduler: `bswap` value plus an add, flags from a later ALU.

An attempt at the variable-shift class (`masked_shift_count_details` peeling
`and(chain, hw_mask)` and materialising the chain into RCX) produced candidates
whose measure and write spellings diverged, so `derive_emitted_candidate_cost`
returned `PL_ERROR_X86_SELECT` at `0x401add`.  It was reverted; a correct fix
must keep `measure_alu_tree`/`write_alu_tree` byte-identical for the peeled
count chain.

### Recursive lane insert (2026-09-18, 8 -> 7)

`0x463a00` carries `n5 = insert(n3, n4, 8)` as an *operand* of the register xor
`n6 = ALU_REGISTER[0][4](R8, n5)`, so a publication-level rule cannot reach it.
`node_base_lane_insert` plus a case inside `measure_alu_tree`/`write_alu_tree`
(materialise the base into the destination, alias base -> destination, then
apply the inner value at the insert width, restoring the previous alias)
closes it: 8 -> 7.  The alias is saved and restored so the recursive use never
leaks into a sibling tree; the write path uses local alias copies so the const
selection stays untouched.

Remaining **7**: `0x44792e 0x4540e1 0x4083ba 0x419718 0x47cc7c 0x415863
0x4170ca`.

### `0x200` scheduler deadlock: entry-read provenance (exact)

`-O0` gdb shows `0x44792e` failing with `pending = 0xb = {L0,L1,L3}` after the
flag producer `L13` was emitted.  The cycle:

- `L0` (the `select`) has `dep = 0x8` (needs `L3`'s new `RBX`), so it waits.
- `L3` (`n1 = RBX - 16`) is skipped by `used_by_others` because `sources[L0]`
  contains bit 3 (entry `RBX`).

`L0`'s tree contains the `X86_FLAGS` node `n2 = SUB(RBX_entry, 16)` whose result
is `n1`, i.e. the same in-place instruction that publishes `L3`.  So the entry
`RBX` read belongs to the *producer's* own instruction, not to `L0`; `L0` only
needs the produced value (its `dep`).  A blanket `sources &= ~dependencies`
would be unsound when a tree genuinely reads both the entry and the new value of
one coordinate, so the fix must separate "entry read consumed by an in-tree
producer" from an independent entry read.  `frame_publication_clobbers_flags`
was also missing `lane32/64.select` (CMOV preserves flags); adding it is sound
but did not by itself close the block.

Both attempts were implemented and reverted: the `X86_FLAGS` provenance rule in
`operand_source_law` and the `lane32/64.select` non-clobber entry each made
`select-x86-check` RED at the `live select common zero` fixture (a select whose
zero arm must stay a common zero).  The fixture is the guard: changing the
select's flag preservation changes the chosen schedule and loses that optimum.
Any future scheduler fix must keep that fixture green.  Population remains 7.

### Recursive bswap (2026-09-18, 7 -> 6)

`0x4540e1` fails in the projection branch because its tree contains
`n3 = bswap(RAX)` and bswap was only handled at the publication level.  A
recursive case in `measure_alu_tree`/`write_alu_tree` (materialise the source,
then `0F C8+rd`, REX.W for the 64-bit form) closes it: 7 -> 6.  The
`X86_FLAGS` provenance rule in `operand_source_law` is also kept: it advances
`0x44792e` past the scheduler and leaves `select-x86-check` green.

Remaining **6**, each requiring a substantial feature:

- `0x4083ba 0x419718`: the value tree has `CONDITION(COMPARE)` (SETcc over a
  CMP) plus an address constant (`main_arena`); the recursive emitter would need
  relocation-correct address materialisation, not an imm32 compare.
- `0x44792e 0x47cc7c`: a `X86_ALU` value published directly as `{NODE,n}` while
  another local publishes its projection — a duplicate-publication/`operand_expression_bits`
  gap, not a scheduler one after the provenance fix.
- `0x415863`: variable shift whose count chain is `and(RCX,7) << 2` then
  `and(_,31)`; a peeled-chain rule diverged in measure/write and was reverted.
- `0x4170ca`: cmov with two address-constant arms (needs the same
  relocation-correct constant emission as the CONDITION class).

### Variable-shift count (2026-09-18, 6 -> 4)

Two general rules closed both remaining shift witnesses:

- `shift_node_details` now also accepts a masked count chain whose unwrapped
  producer is published at RCX, returning `{LOCAL,1}`; the hardware masks the
  register count, so the explicit AND is redundant.  The producer edge is
  already a `dep` in the source law.  Closes `0x47cc7c` (6 -> 5).
- `masked_shift_count_details` peels `and(chain, hw_mask)` and materialises the
  chain into RCX before `D3 /group`.  The earlier attempt diverged because the
  write branch added `at += written` after `emit_shift_instruction` and the loop
  tail added it again (double count); with the tail owning the final `written`
  the measure and write spellings match exactly.  Closes `0x415863` (5 -> 4).

Remaining **4**: `0x4083ba 0x419718` (`CONDITION(COMPARE)` plus an address
constant), `0x44792e` (cmov with a `const 0` arm), `0x4170ca` (cmov with two
address-constant arms).  The address cases need relocation-correct constant
materialisation; the cmov case needs `conditional_select_details` to accept a
materialisable arm.















## Current work: 2026-09-13 (after 7244589)

The checkpoint's full Linux `make check` and shared-expression UBSan check
passed before the new regressions below. Its immediate IMUL support reduced
the fixed kernel's normalization escapes from 818 to 797; GNU make still had
53. Both scans used the existing baseline inputs, not a distribution rebuild.

High-byte TEST is now a physical coordinate in the ordinary flag and
conditional-value generators. AH/CH/DH/BH retain byte SF/PF/ZF semantics;
using a wider shifted mask would change parity. An existing low-register
alias can supply that byte even when the preferred shared owner is RSI or
another register without a high-byte encoding. Copy-outs of the same final
value do not falsely count as old-generation consumers. A flag-only block
also enters the ordinary ALU frame, and a CMP/TEST branch attaches its control
edge to that same frame instead of rejecting its value grammar at the entry.
Non-entry preserved flags still require their emitted prefix: the existing
CLD regression caught an invalid candidate during this change, and DF/IF
preservation remains enforced. Some byte-order fixtures now select the same
cost through the common ALU production; their work/span bounds are unchanged.

Windows condition-code execution passes 1,155,072 comparisons, including
every high-byte value, six masks, all 16 conditions, retained/overwritten
owners, and copy-outs. Carry and comparison checks still pass 4,653,056 and
39,845,888 comparisons. No source-body candidate is executed as a substitute
for these generated high-byte tests.

The expanded grammar exposed a kernel Pareto frontier at
`0xffffffff8133132c..0xffffffff8133134e`: span/work 4/11 versus 5/10.
The common rewrite now substitutes
`select(2^q,0,(x & 2^p)!=0)` with its exact bit projection, including zero-test
polarity, without changing other observers of the original flags. For two
bit-operation chains from the same entry register, copying only the shorter
arm minimizes `max(a+1,b)` versus `max(a,b+1)` at the same work. The real
cut now emits 9 work / 4 span / 31 bytes; 4,096 source/generated/reference
executions verify its two value publications, independent output and flags.
The regression explicitly keeps the previous span-4 bound so a rewrite
cannot appear to resolve Pareto by dropping the faster spelling.

The two former broad selector regressions are historical; both are resolved
(see the 2026-09-18 entry). The retaining analysis below is kept because the
same deadlock reasoning bounds the implemented schedule.

- The bit-projection matrix is green on the native host. All 1,511,424
  source/generated/reference comparisons pass, and every one of the former 77
  coordinate/polarity frontiers now has a generated spelling inside the
  work/span bound. The selector emits the normalized single-bit projection as
  a self-zero, a lane bit test and a conditional move instead of the
  destructive shift/and/xor tree, removing the mandatory entry copy from the
  critical path. `zero_flag_frame_shape` plus its measure and write paths own
  this production; the arithmetic spelling stays available wherever it is
  equal or better.
- GNU make's exact jhash interval `0x18f31..0x18f9f` is expression cut 17.
  It retains 39 work / 14 span only as source, with 30 SSA nodes and an SSA
  work floor of 31. Final-root scheduling leaves RAX/RDX/RBP/R12 pending
  (`0x1025`); each still reads entry mask `0x3025`. A native reproduction
  confirms the deadlock is a cycle of entry-value anti-edges: every pending
  root reads some entry register that another pending root overwrites, while
  the two publication edges RAX<-RBP and RDX<-R12 only order the cycle.
  Preserve shared intermediate generations through the whole DAG, including
  ADD3's shared pair, rather than recursively rebuilding a tree per final
  register or adding a symbol-specific recipe. A scratch register cannot be
  borrowed from an untouched GPR: the complete-future mask keeps those
  coordinates live as identity publications, so a temporary must occupy one of
  the overwritten output registers and survive across roots. The fix is
  therefore a shared-DAG register schedule, not an extra publication row. Two
  further facts bound that schedule.  Hand calculation on the 30-node plan
  gives the generalizing rewrite: every `ADD3(a,b,c)` whose two operands are
  already defined by an earlier binary `ADD` node must be re-associated to
  `ADD(remaining,pair)`.  Here `node7=ADD3(RAX,entryRDX,R13)` with
  `node1=ADD(entryRDX,R13)`, `node15=ADD3(node7,node9,node13)` with
  `node11=ADD(node7,node9)`, and `node23=ADD3(node15,node17,node21)` with
  `node19=ADD(node15,node17)`.  This is transitive.  It drops entry-RDX's last
  use to node 1, entry-RDX/RBP/RSI/RDI/R8/R12 to their single defining node,
  and the chain's maximum live set to four, so the seven output registers are
  sufficient.  With it, a schedule of exactly 39 instructions exists by hand:
  every node overwrites a dead operand, the four ADD3 pairs cost two
  instructions each, and the tail needs one copy-out.  The remaining work is
  therefore the allocator, not the grammar: a first-fit still dead-ends around
  node 12 and in the node 23..29 tail because the source deliberately copies a
  live generation aside (e.g. `mov r12d,edx; mov edx,ebp`) to free a
  coordinate for the next stage.  The implementation needs either
  farthest-next-use spilling or bounded backtracking over the output
  registers, which are the only legal temporaries here. Implemented as
  `measure_direct_shared_dag_frame`: the greedy first-fit is tried first, then
  a bounded DFS over destination choices with farthest-next-use spilling and
  an exact final-placement pass. Cut 17 selects at work 39.

The current production sources complete the GNU make scan with 42,184 /
42,184 selected blocks, zero Pareto violations and 49 normalization escapes
(1,489 -> 1,493 source/output escape bytes; 115 work delta). It still refuses
publication. The final fixed kernel scan selects all 788,279 blocks, with zero
Pareto violations and 743 normalization escapes (818 before this work;
18,696 source/output escape bytes, 1,313 work delta). Its next first interval
is `0xffffffff8120731a..0xffffffff81207333`, work 6 versus SSA floor 5:
publish ECX from R15D, compute `(4096ull << CL) >> 20`, publish both RAX/RSI,
retain the final shift flags, and bind the independent RDI address.

Full Linux `make -k check` returns failure only at the shared-ARX selection
fixture and bit-projection optimization matrix; other check targets pass.
After extending that matrix to byte/word tests, the latest separate UBSan
build completes all 1,478,656 Linux source/generated/reference comparisons
without a sanitizer diagnostic. It returns failure for the same 77 cost
gaps, not a passing overall check. TZCNT/LZCNT execution remains explicitly
skipped on the build guest; Windows executes those cases. The postlink C
sources were instrumented with `-fsanitize=undefined -fno-sanitize-recover=all`
and warning errors enabled. There is still no optimized release, product
boot or paired native benchmark; reuse the fixed baseline checkpoints.

## Current work: 2026-09-13 (after f97ec8d)

The shared shift/OR regression is green. A `q OP shift(q,k)` diamond now
generates its parent once and reuses an entry register only after proving
that no external consumer still needs that generation. The ordinary
generation handoff can capture independent leaf publications before its
seed, defer a shared join, and emit the exact final constant operation last.
Transient ownership is also recognized at expression roots. No extra runtime
representation, source-body retention, or publication-gate exception is added.
When ADD3 substitution flattens a shared sum, the shift's existing definition
recovers that same sum edge; no node search or rebuilt expression tree is used.

The first kernel witness was not covered by the previous small fixture's
live-source subsequence candidate. Its real construction-field ownership
forbids that candidate. The regression now includes those fields and mapped
read-only address targets, and verifies the entire formed interval. Native
BSR/BSF, TZCNT/LZCNT and POPCNT publications now use the ordinary expression
scheduler. `0 - x` uses NEG with its exact arithmetic flags. Zero-input
BSR/BSF destinations remain architecturally undefined, not an assumed zero.

The following kernel witness, `0xffffffff8120588f..0xffffffff812058a7`,
normalizes `x == 0 ? 1 : x` to `x + (x < 1)`: CMP/ADC uses no constant-arm
register. Narrow comparisons also consume an already projected entry word
without materializing it again. The focused complete cut decreases from
6 to at most 5 work; this is an instruction-graph measurement, not native
elapsed-time speedup. Comparison flags that remain observable are not replaced
by the carry spelling.

Before the immediate-multiply changes below, Windows executable checks passed:
shared-expression 1,081,344 comparisons,
carry 4,653,056, comparison 39,845,888, and condition-code 860,160. Selection
and global-minimum checks pass. The full Linux `make check` passed at that
revision. Its shared-expression check and its separate UBSan build
each pass 1,048,576 comparisons; this build guest explicitly skips TZCNT and
LZCNT execution because its CPUID does not expose those features. Both were
executed in the Windows check. The sanitizer build instruments the postlink
C sources and uses `-Wall -Wextra -Wshadow -Wconversion -Werror` and
`-fsanitize=undefined -fno-sanitize-recover=all`.

The last fixed kernel pass before immediate-multiply support selects
788,279 / 788,279 blocks, with zero
Pareto violations and 818 normalization escapes (833 at f97ec8d). The first
remaining witness is `0xffffffff81206586..0xffffffff8120659e`, with emitted
work 7 and SSA work floor 4. GNU make selects 42,184 / 42,184 blocks with zero
Pareto violations and 53 escapes (54 at f97ec8d); its first remaining witness
is the jhash ARX loop at `0x18f31..0x18f9f`, with work 39 and SSA floor 31.
Both publication gates still fail. These are not optimized release size or
native hardware benchmark results. The baseline distribution checkpoints
remain intact and reusable. No full distribution rebuild was needed.

After the build-host process stopped, its existing Windows qcow2 checkpoint
booted successfully and recovered its filesystem journal. The current source
was synchronized and the full checks and both real scans were rerun; the old
process handles were not treated as live jobs or reused as completion evidence.
Continue from the two witnesses above, then the aggregate toolchain identity,
package/root publication, actual product boot and paired workloads below.

### Immediate-multiply checkpoint

The kernel's shifted-product witness now has a complete-cut regression.
The general expression generator accepts constant IMUL operands, preserves
a 32-bit shift before a 64-bit product, and uses the three-operand immediate
encoding when the multiplicand has a different register owner. It does not
materialize an encodable constant or copy that input solely for IMUL.
The executable matrix covers signed immediate boundaries, 32/64-bit shift
and product widths, masked shift counts, retained input generations, and
the final ADD's defined flags. A no-op shift requires at most two work when
no separate width projection is needed; the other cases allow four.

The current Windows shared-expression check passes 1,425,408 independent
source/generated/reference comparisons. Selection, condition-code,
carry-cut, compare-cut and global-minimum checks also pass on this revision.
The full Linux suite,
UBSan run, and real kernel/make scans above predate these multiply changes
and must be rerun after synchronizing the checkpoint. No new release size,
normalization-escape count, or native timing is inferred from these tests.

## Checkpoint: 2026-09-13 (f97ec8d; selection test red)

The relocation regression is fixed without disabling source-field ownership.
RIP-relative addresses retain their full target binding when a consumer uses
only the low 32 bits; LEA r32 performs the projection after rebinding. The
condition-code check independently moves the target and generated body, and
passes 860,160 source/generated/reference comparisons.

Conditional publication now distinguishes old-GPR -> comparison flags from
new-GPR -> CMOV. An acyclic pair of flag-preserving arm publications can run
between that comparison and CMOV, without copying the old GPR or materializing
a Boolean. This uses the ordinary ALU and comparison-branch generators, not a
kernel-specific spelling. A full-width constant publication can also own a
CMOV r32 arm without losing its own high bits. The comparison suite executes
39,845,888 cases: all comparison widths and conditions, entry versus published
generations, both arm-copy orders, final shared versus independent flags,
and branch versus non-branch exits. The kernel witnesses at
`0xffffffff812045ea` and `0xffffffff81204f83` now use the general production.

ALU results and their flags now share a producer when a subsequent CMOV
observes those flags. ADD/SUB/AND/OR/XOR/NEG use the ordinary expression
generator, including 32/64-bit values, all 16 conditions, and branch versus
non-branch exits. The expanded carry check passes 4,653,056 executable
source/generated/reference comparisons.

The Linux `make check` passed in the Windows-hosted build guest before the
latest shared bit-fill selection fixture was added. The comparison suite
also passed with the postlink C sources instrumented by
UBSan (`-fsanitize=undefined -fno-sanitize-recover=all`). The sanitizer build
exposed three integer-promotion warnings in bit readers; those are corrected
without widening stored words, and the bounded predecessor mask no longer
needs a special full-byte branch. Fresh Windows condition-code, comparison
and carry checks pass; the selection check is currently RED as described
below. The earlier global-minimum check passed. `native-layout-check` requires
Linux `sys/mman.h`; it is covered by the guest full check, not a Windows-host
executable test.

The real kernel scan selects 788,279 / 788,279 blocks with zero Pareto
violations and 833 normalization escapes (862 before this work). The first
remaining witness is `0xffffffff81205340..0xffffffff81205361`, an absolute-value
selection followed by BSR and constant publications. GNU make still selects
42,184 / 42,184 blocks, with zero Pareto violations and 54 normalization
escapes; its first witness remains `0x186bb..0x186f5`, shared shift/OR bit-fill
publications. The older count of 52 predates mandatory address-alias validation
and is not the current closure result. Both real publication gates still fail;
there is no complete optimized kernel, native release, product boot, or paired
hardware benchmark yet. Reuse the baseline package checkpoints below.

The new `shared_bit_fill` fixture reproduces GNU make's first witness in the
general selection check: expression cut 12 reports work/span 17/11 and
rejection 200/81. Repeated `q | (q >> k)` diamonds need shared parent generation
and correct publication lifetimes, including the separately observed final
shift and ADD flags. Do not replace the arbitrary entry values with an assumed
single bit-fill input or retain the source body to silence this regression.
The focused absolute-value fixture passes, but the full kernel witness above
still fails; investigate its BSR/block construction and candidate context.
This checkpoint preserves that red test. The current full suite is not green,
and no optimized release is being published.

## Checkpoint: 2026-09-13 (b08e073; tests red)

The current working changes extend the shared native expression/publication
path: carry masks use SBB instead of a materialized Boolean; arithmetic-result
branches reuse the ordinary ALU frame; signed extensions preserve narrower
producer widths; CMP/TEST constants normalize at their observed width; and
comparison flags can be shared through CMOV followed by sign extension or NOT.
A 32-bit full-mask rewrite also now preserves the required zero extension.
Executable carry, comparison, extension and selection regressions accompany
these changes. The signed clamp witness reaches 4 work / 3 span; this is an
instruction-graph cost, not a native elapsed-time measurement.

Before the latest address-field alias validation change, the fixed kernel
scan selected 788,279 / 788,279 blocks with zero Pareto violations and 862
normalization escapes, down from 1,485. Its first remaining witness was
`0xffffffff812045ea..0xffffffff81204604`. GNU make selected 42,184 / 42,184
blocks with zero Pareto violations and 52 escapes, down from 81; its first
witness was `0x186bb..0x186f5`. Both publication gates still fail. These counts
predate the latest change and are not successful optimized release results.

The latest Linux `make check` is RED. Allowing frames with constant/copy GPR
outputs and live comparison flags exposed missing source-address relocation
bindings in `modular-address-check`. Adding source-address alias validation
makes that check pass, but now `condition-code-check` rejects its RIP-relative
32-bit CMOV fixture (`cc=0`, `bits=32`, `published=0`, `relative=1`) because no
bounded generated body is accepted. Resolve full-address relocation ownership
versus low-32-bit value projection without weakening either check. Then rerun
the full check and the fixed kernel/GNU make scans before claiming new closure
counts. The expanded comparison, carry and extension checks previously passed
14,680,064, 3,080,192 and 245,760 comparisons respectively; those passes do not
override the current full-suite failure.

This is a work-in-progress checkpoint, not a green release. All baseline build
checkpoints below remain reusable; do not rebuild the distribution from scratch
to fix this selector regression.

## Previous checkpoint: 2026-09-13 (965a337)

The Windows-hosted QEMU build guest has built the fixed Linux 7.1.8 kernel
and bzImage, BusyBox, the toolchain package set (including Git 2.55.0),
init/service packages, core tools, and the standard system-tools package set
(apk-tools, network/time/account/filesystem providers, nano and timezone data).
The common kernel builder reused its existing objects; the linked ELF remains
19,920,248 bytes, SHA-256
`fd91322e1f807e7121b5a3ad423b6aabe15a655bebb81fe429415296b6822ad6`.
These are baseline build checkpoints, not a complete optimized
distribution, a product boot result, or a native performance measurement.
The build guest and all its checkpoints reside on the Windows host; no
NixOS or WSL inputs are used.

Fresh Windows checks pass: `select-x86-check`, `condition-code-check`
(573,440 source/generated/reference comparisons), `arithmetic-cut-check`
(24,576 comparisons), `shift-width-check` (86,295 comparisons),
`compare-cut-check` (3,145,728 comparisons), `carry-cut-check` (1,441,792
comparisons) and `extension-cut-check` (122,880 comparisons). The
conditional-move check includes 32-bit false-arm zero extension, every
condition code, and entry versus published register generations. The root
measurement regression also passes in the Linux build guest; its C xattr
extent reader measures names and lengths without materializing values.

The fixed GNU make input selects all 42,184 blocks. Normalization escapes
have decreased from 164 through 121 to 81, with no remaining Pareto violation in that
input. Publication still fails, as required; this is not a successful
optimized GNU make build. The first remaining witness is
`0x12ca2..0x12ccd`. Compare/borrow now lowers through the shared expression
generator: `a+k +/- CF` consumes the carry flag directly, ADD3's zero identity
is removed before selection, and immediate literals do not depend on equal
future register publications. The existing multiplication/carry production
consumes this same binary sum normal form; it does not retain the old ADD3
zero spelling.

Immediate and register CMP/TEST now use the same expression/publication
generator; the leaf-only immediate branch path and its selection flag were
deleted. An already published constant may supply a shorter register operand
within that same grammar. Zero extension uses MOVZX/MOV inside expressions
as well as at frame roots. TEST's scalar Boolean and observed flags share one
TEST production, including when SETcc overwrites a comparison input.
Shared ALU value and condition publications likewise emit one ALU operation:
safe Boolean destinations are zeroed before it, while aliased inputs use a
flag-preserving zero after it. Publication dependencies defer the whole group
until its inputs are available. The expanded carry check executes 32/64-bit
ADD/SUB/AND/OR/XOR with all 16 conditions, aliased Boolean destinations and an
independent final TEST/Jcc, against both the source and a C reference.

The expanded comparison check executes all widths and condition codes with
immediate/register operands, pure AND/shift publications and Jcc/SETcc outputs.
The extension check executes zero-extended 8/16/32-bit seeds followed by
32/64-bit ADD/SUB/AND/OR/XOR, preserving the final flags and a rebased pointer.
The arithmetic check also covers shared signed/unsigned word publications.
For example, one shifted word can be computed in the incoming accumulator,
copied to its unsigned output and sign-extended in place. This closes the
kernel witness at `0xffffffff8148695d` at 5 work / 3 span, instead of keeping
the incomparable 5/4 and 6/3 candidates. These are measured instruction-graph
costs, not hardware elapsed-time speedups or an unbounded ISA minimum proof.

The full Linux `make check` passes, including `call-cut-check` and dynamic
unwinding. The latter exposed a real PIE fault: a linked pointer below 4 GiB
was copied through a 32-bit GPR after rebasing. Copies now respect the emitted
RIP-relative binding's full width. The executable unwind fixture uses libgcc's
unwind interface on musl and checks the three expected function regions as
well as stack depth. The latest expanded carry check passes on Windows; the
Linux full-check result predates that test expansion. The last whole-kernel
pass, before shared ALU/condition publication was added, selects all 788,279 blocks,
with zero Pareto violations and 1,485 normalization escapes (down from 2,178
at the previous checkpoint). Its first remaining witness is
`0xffffffff81202e00..0xffffffff81202e13`: ADD's value/carry publications before
an independent byte TEST/Jcc. This witness now passes its focused selection
regression, but whole-kernel counts have not been remeasured after the fix.
The last whole-kernel publication correctly fails.
Selection coverage is not normalized closure and does not constitute a
successful optimized kernel build. Recover remaining real-input escapes through general
productions and executable regressions, not source retention or weakened
publication gates.

Before release assembly, bind the top-level toolchain population and its
`.assembled` checkpoint to the Git build-only Rust closure and all component
recipe identities. The Git component already has this binding; the aggregate
assembly identity does not yet include it. Then validate the assembled fixed
package closure, postlink every ELF, and validate the actual product boot and
paired workloads. Artifact publication and the complete native distribution
remain unfinished.

## Objective and execution environment

Complete the fixed `development-standard-v1` distribution through ordinary
linked x86-64 ELF -> independently executable optimized ELF with embedded proof
-> verified native execution -> bounded Wasm modules -> browser VM execution.
Publish the complete package/root closure once, measure native execution and
canonical storage against the same fixed source identities, then validate
cold browser shell within three seconds, C compile/run, `make -j`, Git/HTTPS,
and the declared Linux test suites. No runtime interpreter or missing-block
fallback is an accepted completion condition.

Development and the instruction-level checks run on a native x86-64 Linux host
with GCC or Clang, GNU make, binutils and the pinned Zydis submodule
(`git submodule update --init --recursive`; then `make` and `make check` under
`src/v2`). NixOS, WSL and their temporary build trees are not inputs. Upstream
archives and fixed recipes remain under `data/`; disposable work stays out of
tracked paths. The executable checks are valid on any x86 CPU that exposes the
declared feature set; the full fixed-distribution build and its paired native
workloads still use the reproducible environment under `data/`, not a host
toolchain alone.

The previous Linux native-emission diagnostic reported 2,566 normalization
escapes. This is a historical checkpoint, not a fresh result. Reproduce its
instruction witnesses natively before changing selection, and remeasure the
complete fixed inputs once their reproducible build is available. The Wasm
backend still returns `WASM_COMPILER_ERROR_INCOMPLETE`, the editor worker
advertises execution unavailable, and no complete Linux release is published
in the artifact catalog. Full-coordinate catalog acceptance alone does not
complete any of those product gates.

The first historical native-emission witness, the 37-byte block at
`0xffffffff81202909..0xffffffff8120292e`, now reaches the normalized native
production on Windows. A 64-bit shift feeding a 32-bit flag-producing AND
must retain the shift's own width; modular arithmetic and bitwise inputs may
still use exact low-bit spellings. The block remains 8 work / 3 span, so this
is coverage recovery, not a measured speedup. `shift-width-check` independently
executes source and generated x86 and checks defined flags against C arithmetic
for 86,295 boundary/random cases. The same check also exposed a redundant
zero-extension before 32-bit rotate: the existing low32-input normalization
now includes both rotate directions. The complete Linux escape population
has not yet been remeasured from a reproducible build.

The order is fixed. A later stage may not compensate for a red earlier stage.

## 1. Complete the distribution recipe

- Build exactly the package and service closure declared by
  `data/distribution/profile.env`.
- Optimize each linked `ET_EXEC`/`ET_DYN` before package creation and signing.
- Assemble one candidate root and pass `data/distribution/check-root.sh`.
- Do not publish a tar, SquashFS extent or filesystem walk as Artifact
  identity or release size.

## 2. Emit optimized native x86

- Replace the remaining retained stateful source instructions with direct x86
  emitted from the closed normalized physical SSA.
- Preserve precise fault cuts, both conditional arms, direct calls and total
  indirect dispatch.
- Put no SSA graph, residual table or private program section in the output.
- Reject the compile if one selected executable coordinate is not closed.

The product path derives finite native entries from `e_entry`, executable
symbols and linker-retained code relocations, then closes direct successors
with two bitsets and one u32 queue. It does not retain decoded rows or one plan
per executable coordinate. Boundaries are sorted by a linear bitset walk and
each final block is normalized once. It emits one compact executable extent,
rebinds direct and RIP-relative fields, rewrites affected runtime relocation
state, seals a standard proof, and directly executes checked static and dynamic
ELFs. The current real-ELF closure fixture covers all 47 selected blocks and
reduces 72 source instructions to 67 emitted instructions and 252 selected
bytes to 232 bytes; its diagnostic normalized physical objective is
98 -> 71 work and 86 -> 50 span.

Remaining publication blockers are stateful physical-SSA selection instead of
source-byte retention, total indirect dispatch, unsupported allocated-metadata
encodings, multiple executable-load layouts, and the full Linux/toolchain
differential population. One missing reference remains a compile error; it
must not become a runtime path.

Typed constructor rows are compiler workspace, never output. Connect selected
native instructions directly to normalized blocks; do not publish diagnostic
parameter functions, entry arrays, bitsets or the closure queue as a
replacement row format.

## 3. Make performance a measured publication gate

- Run source and optimized ELFs from the same filesystem and cache policy.
- Require identical `argv[0]`, arguments, exit state and output digest.
- Alternate pair order and report distributions, retired instructions, cycles,
  page faults and maximum RSS where the host exposes them.
- Keep static work/span as a non-regression proof; never label it elapsed time.

## 4. Publish the canonical executable artifact

- Bound all reachable and future-equivalence populations before materializing
  them.
- Emit the single self-delimiting canonical program word from `ARTIFACT.md`.
- Reference equal immutable extents once; do not copy filesystem bytes into
  boot RAM, resource pages or proof metadata.
- Enforce the 75,000,000-byte payload target at this boundary only.

## 5. Project delivery independently

- Feed only the canonical remainder to `STORAGE.md`.
- Replace fixed digest/offset rows with canonical-rank interval generators.
- Report `release.transfer_bytes`, authentication, parity and fetch
  amplification separately from executable identity.

## 6. Lower accepted x86 to Wasm and boot Linux

- Make `wasm-compiler` decode the accepted optimized ELF; it must not consume
  a private sidecar or rerun a different optimizer.
- Install bounded modules in `vm.wasm` with no runtime decoder or missing-block
  route.
- Rebuild Linux + BusyBox + the standard development closure and pass browser
  cold boot, shell, C compile/run, `make`, Git/HTTPS and the declared Linux test
  suites.
