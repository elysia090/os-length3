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

**Open red: the Pareto-unresolved class (kernel `0xffffffff81397304`, static
glibc `0x41bb01`).**  Each is a normalized candidate traded against the retained
source on incomparable cost:

| witness | normalized (span/work/bytes) | source (span/work/bytes) |
| --- | --- | --- |
| `0xffffffff81397304` | `2/6/24` | `3/5/22` |
| `0x41bb01` | `3/11/38` | `4/7/25` |

`pl_x86_candidates_select_joint_minimum` returns `PL_ERROR_X86_PARETO` because
neither spelling dominates.  The normalized candidate is exhausted by
materialising the `cmov` compare operands; resolving the class needs a
multi-select shared-flag handoff (or a cost-canonical choice between the
shorter-span normalized spelling and the lower-work source).  The earlier
all-near `control_relaxed_at` diagnostic is gone.

**Stage 3, measured performance gate: not started.** Only the tiny real
workloads above are paired; there are no fixed source identities, canonical
roots, or `postlink-workloads.tsv` measurements.

**Stages 4-6, Artifact / Storage / Wasm / VM boot: not started.** The Wasm
backend still returns `WASM_COMPILER_ERROR_INCOMPLETE`, no release artifact is
published, and no product boot or browser cold shell has been validated.

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
