#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$here/../.." && pwd)
temporary_root=$repo/temp
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/optimize-payload-check.XXXXXX")
case $temporary in
  "$temporary_root"/optimize-payload-check.*) ;;
  *)
    printf 'unexpected payload-check temporary path: %s\n' \
      "$temporary" >&2
    exit 2
    ;;
esac
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

stage=$repo/compiler/build/artifact-executable-stage
verify=$repo/compiler/optimized-x86/build/postlink-verify
input=$temporary/input
output=$temporary/output
report=$temporary/report
mkdir -p "$input/bin"
${CC:-cc} -O0 -g -Wl,--emit-relocs \
  "$repo/compiler/postlink-compiler/check/elf-proof-fixture.c" \
  -o "$input/bin/a"
${CC:-cc} -O0 -g -DRELEASE_SHARING_VARIANT -Wl,--emit-relocs \
  "$repo/compiler/postlink-compiler/check/elf-proof-fixture.c" \
  -o "$input/bin/b"
ln "$input/bin/a" "$input/bin/a-link"
mkdir -p "$input/lib"
mkdir -p "$input/share"
printf 'shared-rodata-tail\n' >"$input/share/readme"
ln "$input/share/readme" "$input/share/readme-link"
printf 'int archive_a(void) { return 1; }\n' >"$temporary/archive-a.c"
printf 'int archive_b(void) { return 2; }\n' >"$temporary/archive-b.c"
${CC:-cc} -c "$temporary/archive-a.c" -o "$temporary/archive-a.o"
${CC:-cc} -c "$temporary/archive-b.c" -o "$temporary/archive-b.o"
${AR:-ar} rcsD "$input/lib/development.a" \
  "$temporary/archive-a.o" "$temporary/archive-b.o"
ln "$input/lib/development.a" "$input/lib/development-link.a"

# Exercise the product CLI contract with relative paths as well as the
# absolute paths emitted by the tree scanner.  A path must become a namespace
# coordinate exactly once, never `root/root/...`.
(
  cd "$repo"
  POSTLINK_PAYLOAD_REPORT=$report "$here/optimize-payload.sh" \
    "${input#"$repo"/}" "${output#"$repo"/}" \
    "${stage#"$repo"/}" "${verify#"$repo"/}"
)
grep -qxF 'format=optimized-payload-report-v12' "$report"
grep -qxF 'complete_gate=1' "$report"
grep -qxF 'semantic_family_mask=63' "$report"
grep -Eq '^normal_instruction_occurrences=[1-9][0-9]*$' "$report"
grep -Eq '^normal_instruction_classes=[1-9][0-9]*$' "$report"
grep -Eq '^normal_instruction_shared_occurrences=[0-9]+$' "$report"
grep -Eq '^normal_instruction_opened_bytes=[1-9][0-9]*$' "$report"
grep -Eq '^normal_instruction_class_bytes=[1-9][0-9]*$' "$report"
grep -qxF 'stored_normal_instruction_bytes=0' "$report"
grep -Eq '^normal_instruction_minimum_proofs=[1-9][0-9]*$' "$report"
grep -Eq '^normal_instruction_joint_witnesses=[1-9][0-9]*$' "$report"
grep -Eq '^normal_instruction_work_lower_bound_sum=[0-9]+$' "$report"
grep -Eq '^normal_instruction_span_lower_bound_sum=[0-9]+$' "$report"
grep -Eq '^checked_successor_coordinates=[1-9][0-9]*$' "$report"
grep -qxF 'stored_residual_state_rows=0' "$report"
grep -qxF 'stored_residual_edge_rows=0' "$report"
grep -Eq '^complete_future_classes=[1-9][0-9]*$' "$report"
grep -Eq '^canonical_byte_extent=[1-9][0-9]*$' "$report"
grep -qxF 'stage_processes=1' "$report"
grep -Eq '^state_capacity_growths=[1-9][0-9]*$' "$report"
grep -Eq '^elf_capacity_growths=[1-9][0-9]*$' "$report"
grep -Eq '^factor_workspace_bytes=[1-9][0-9]*$' "$report"
grep -qxF 'factor_gap_bits=0' "$report"
grep -qxF 'archive_paths=2' "$report"
grep -qxF 'archive_inodes=1' "$report"
grep -qxF 'complete_archive_count=1' "$report"
grep -Eq '^archive_member_occurrences=[1-9][0-9]*$' "$report"
grep -Eq '^archive_symbol_occurrences=[1-9][0-9]*$' "$report"
grep -Eq '^generated_archive_bytes=[1-9][0-9]*$' "$report"
grep -qxF 'external_payload_occurrences=1' "$report"
grep -Eq '^external_payload_bytes=[1-9][0-9]*$' "$report"
grep -Eq '^namespace_paths=[1-9][0-9]*$' "$report"
grep -Eq '^namespace_inodes=[1-9][0-9]*$' "$report"
grep -Eq '^namespace_material_occurrences=[1-9][0-9]*$' "$report"
grep -Eq '^namespace_retained_basename_bytes=[1-9][0-9]*$' "$report"
grep -Eq '^namespace_topology_bits=[1-9][0-9]*$' "$report"
grep -qxF 'archive_hardlink_aliases=1' "$report"
test "$(stat -c %i -- "$output/bin/a")" = \
  "$(stat -c %i -- "$output/bin/a-link")"
test "$(stat -c %i -- "$output/lib/development.a")" = \
  "$(stat -c %i -- "$output/lib/development-link.a")"
# The output owns its immutable payload lifetime.  Its aliases remain one
# inode, but repeated projections must not add hard links to the build input's
# inode (which made long-lived Windows/DrvFS checkpoints hit EINVAL).
test "$(stat -c %i -- "$output/share/readme")" = \
  "$(stat -c %i -- "$output/share/readme-link")"
test "$(stat -c %i -- "$input/share/readme")" != \
  "$(stat -c %i -- "$output/share/readme")"
"$repo/compiler/artifact/build/artifact-measure-root" \
  "$output/lib/development.a" "$temporary/archive.population"
grep -qxF 'archive.identity=canonical-gnu-ar-view-v1' \
  "$temporary/archive.population"
"$verify" "$input/bin/a" "$output/bin/a" >/dev/null
"$verify" "$input/bin/b" "$output/bin/b" >/dev/null

# An optimized component is not a legal input population for another
# post-link pass: its construction relocations have already been consumed.
# Accepting it would make component identity a sharing boundary and lose
# cross-component block/slice/instruction equivalence.
second=$temporary/output-second
second_report=$temporary/report-second
second_error=$temporary/error-second
if POSTLINK_PAYLOAD_REPORT=$second_report "$here/optimize-payload.sh" \
    "$output" "$second" "$stage" "$verify" 2>"$second_error"; then
  printf 'optimized payload incorrectly re-entered post-link compilation\n' >&2
  exit 1
fi
if ! grep -q 'lacks static construction relocations' "$second_error"; then
  printf 'unexpected second-pass rejection:\n' >&2
  cat "$second_error" >&2
  exit 1
fi
[[ ! -e $second ]]

component_routes=(
  "$repo/distribution/toolchain/build.sh"
  "$repo/distribution/packaging/build-init.sh"
  "$repo/distribution/packaging/build-core-tools.sh"
  "$repo/distribution/packaging/build-system-tools.sh"
)
if grep -l 'optimize-payload\.sh' "${component_routes[@]}" \
    >"$temporary/component-routes"; then
  printf 'component-local post-link route remains:\n' >&2
  cat "$temporary/component-routes" >&2
  exit 1
fi
# One reference binds the stage into release identity and exactly one invokes
# it for the complete linked package set.  Counting the script pathname alone
# would mistake the identity hash for a second execution route.
test "$(grep -c 'packaging/optimize-payload\.sh' \
  "$repo/distribution/build.sh")" = 2
test "$(grep -c 'POSTLINK_PAYLOAD_REPORT=' "$repo/distribution/build.sh")" = 1

factor_bytes=$(sed -n 's/^factor_bytes=//p' "$report")
workspace_bytes=$(sed -n 's/^factor_workspace_bytes=//p' "$report")
printf 'optimized payload stage: green '
printf '(one process, two input inodes, hardlink preserved, '
printf '%s stored factor bytes, %s construction bytes, factor gap zero)\n' \
  "$factor_bytes" "$workspace_bytes"
