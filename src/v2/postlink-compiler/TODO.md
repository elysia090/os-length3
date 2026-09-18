# Remaining work

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

Two broad regressions remain RED and must not be weakened:

- The bit-projection matrix verifies 8/16/32/64-bit tests and both polarities.
  All 1,511,424 Windows comparisons pass, but 77 coordinate/polarity cases
  lack a generated spelling attaining the existing componentwise minima.
  The first is input bit 0 -> output bit 31 under a zero test: generated
  work/span 7/4 versus available 6/3. The check executes the entire semantic
  matrix before returning failure for those optimization gaps.
- GNU make's exact jhash interval `0x18f31..0x18f9f` is expression cut 17.
  It retains 39 work / 14 span only as source, with 30 SSA nodes and an SSA
  work floor of 31. Final-root scheduling leaves RAX/RDX/RBP/R12 pending
  (`0x1025`); each still reads entry mask `0x3025`. One transient alias is
  insufficient. Preserve shared intermediate generations through the whole
  DAG, including ADD3's shared pair, rather than recursively rebuilding a
  tree per final register or adding a symbol-specific recipe.

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

As of 2026-09-12, development uses the Windows host only. Do not invoke NixOS,
WSL, or use their temporary build trees as inputs. Upstream archives and fixed
recipes remain under `data/`; disposable work belongs under the repository's
Windows `temp/`. Rebuild C tools with the native Windows toolchain. A Linux
target build or execution check needs an explicit reproducible cross-toolchain
or emulator; host Windows execution is not a Linux workload benchmark.

The previous Linux native-emission diagnostic reported 2,566 normalization
escapes. This is a historical checkpoint, not a fresh result. Reproduce its
instruction witnesses on Windows before changing selection, and remeasure the
complete fixed inputs once their Windows-side build is available. The Wasm
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
has not yet been remeasured on Windows.

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
