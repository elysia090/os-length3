# Remaining work

## Checkpoint: 2026-09-13

The Windows-hosted QEMU build guest has built the fixed Linux 7.1.8 kernel,
the toolchain package set (including Git 2.55.0), init/service packages and
core tools. These are baseline build checkpoints, not a complete optimized
distribution, a product boot result, or a native performance measurement.
The build guest and all its checkpoints reside on the Windows host; no
NixOS or WSL inputs are used.

Fresh Windows checks pass: `select-x86-check`, `condition-code-check`
(573,440 source/generated/reference comparisons), `arithmetic-cut-check`
(12,288 comparisons), and `shift-width-check` (86,295 comparisons). The
conditional-move check includes 32-bit false-arm zero extension, every
condition code, and entry versus published register generations. The root
measurement regression also passes in the Linux build guest; its C xattr
extent reader measures names and lengths without materializing values.

The fixed GNU make input selects all 42,184 blocks. Normalization escapes
have decreased from 164 to 142, with no remaining Pareto violation in that
input. Publication still fails, as required; this is not a successful
optimized GNU make build. The first remaining witness is
`0xe119..0xe12d` (compare/borrow and register publication). The full Linux
`make check` is also red at `call-cut-check`, with one normalization escape
at `0x1045..0x1052`. Recover these through general productions and executable
regressions, not source retention or weakened publication gates.

Before release assembly, bind the top-level toolchain population and its
`.assembled` checkpoint to the Git build-only Rust closure and all component
recipe identities. The Git component already has this binding; the aggregate
assembly identity does not yet include it. Then finish the remaining fixed
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
