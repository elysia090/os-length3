# Remaining work

## Checkpoint work: 2026-09-13 (after b08e073; selection test red)

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
