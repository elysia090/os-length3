#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 ]]; then
  printf 'usage: %s INPUT_PAYLOAD OUTPUT_PAYLOAD EXECUTABLE_STAGE VERIFY\n' "$0" >&2
  exit 2
fi

input=$1
output=$2
stage=$3
verify=$4

if [[ ! -d $input || ! -x $stage || ! -x $verify ]]; then
  printf 'post-link payload inputs are incomplete\n' >&2
  exit 2
fi
if [[ -e $output ]]; then
  printf 'post-link payload output already exists: %s\n' "$output" >&2
  exit 2
fi

# `clone-tree.sh` emits absolute physical paths.  Canonicalize every CLI
# boundary once so stripping the input root cannot leave an absolute pathname
# which is then joined to the root a second time.  The output may not exist;
# its parent must, because publication is an atomic rename within that parent.
input=$(realpath -e -- "$input")
output_parent=$(realpath -e -- "$(dirname -- "$output")")
output=$output_parent/$(basename -- "$output")
stage=$(realpath -e -- "$stage")
verify=$(realpath -e -- "$verify")

parent=$(dirname -- "$output")
name=$(basename -- "$output")
partial="$parent/.${name}.partial.$$"
regular_list="$parent/.${name}.regular.$$"
stage_report="$parent/.${name}.executable-stage.$$"
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
archive_normalizer=${QM_ARCHIVE_NORMALIZER:-$script_directory/../../src/v2/artifact/build/artifact-normalize-archive}
if [[ ! -x $archive_normalizer ]]; then
  printf 'archive normalizer is unavailable: %s\n' "$archive_normalizer" >&2
  exit 2
fi
stage_identity=$(sha256sum "$stage" "$verify" "$archive_normalizer" | \
  sha256sum | cut -d' ' -f1)
mkdir -p "$parent" "$partial"
cleanup() {
  rm -rf -- "$partial"
  rm -f -- "$regular_list" "$stage_report"
}
trap cleanup EXIT HUP INT TERM
bash "$script_directory/clone-tree.sh" "$input" "$partial" "$regular_list"

is_linked_x86() {
  local path=$1 magic header
  IFS= read -r -N 4 magic <"$path" || return 1
  [[ $magic == $'\x7fELF' ]] || return 1
  header=$(LC_ALL=C readelf -h -- "$path" 2>/dev/null) || return 1
  grep -q 'Class:[[:space:]]*ELF64' <<<"$header" \
    && grep -q 'Machine:[[:space:]]*Advanced Micro Devices X86-64' \
      <<<"$header" \
    && grep -Eq 'Type:[[:space:]]*(EXEC|DYN)' <<<"$header"
}

is_archive() {
  local path=$1 magic
  IFS= read -r -N 8 magic <"$path" || return 1
  [[ $magic == $'!<arch>\n' ]]
}

declare -A optimized_inode=()
declare -A alias_owner=()
declare -A source_digest_seen=()
declare -A optimized_digest_seen=()
declare -A normalized_archive_inode=()
declare -A archive_alias_owner=()
declare -A external_payload_inode=()
declare -A payload_kind_by_inode=()
declare -A inode_by_path=()
declare -A size_by_path=()
declare -a linked_paths=()
declare -a archive_paths=()
declare -a archive_alias_paths=()
declare -a archive_stage_arguments=()
declare -a external_payload_stage_arguments=()
declare -a unique_paths=()
declare -a alias_paths=()
declare -a stage_arguments=()
while IFS= read -r -d '' path \
    && IFS= read -r -d '' inode \
    && IFS= read -r -d '' source_size; do
  relative=${path#"$input"/}
  if [[ $relative == *$'\n'* ]]; then
    printf 'payload path contains a newline: %q\n' "$relative" >&2
    exit 1
  fi
  inode_by_path[$relative]=$inode
  size_by_path[$relative]=$source_size
  kind=${payload_kind_by_inode[$inode]-}
  if [[ -z $kind ]]; then
    if is_linked_x86 "$path"; then
      kind=elf
    elif is_archive "$path"; then
      kind=archive
    elif [[ $source_size != 0 ]]; then
      kind=payload
    else
      kind=empty
    fi
    payload_kind_by_inode[$inode]=$kind
  fi
  case $kind in
    elf) linked_paths+=("$relative") ;;
    archive) archive_paths+=("$relative") ;;
    payload)
      if [[ -z ${external_payload_inode[$inode]+present} ]]; then
        external_payload_inode[$inode]=1
        external_payload_stage_arguments+=("$partial/$relative")
      fi
      ;;
    empty) ;;
    *)
      printf 'unknown payload kind for %s: %s\n' "$relative" "$kind" >&2
      exit 1
      ;;
  esac
done <"$regular_list"

logical_source_bytes=0
logical_optimized_bytes=0
canonical_source_bytes=0
canonical_optimized_bytes=0
source_objects=0
optimized_objects=0
input_inodes=0
hardlinks=0
stage_processes=0
stage_complete_gate=0
stage_semantic_family_mask=0
stage_block_occurrences=0
stage_slice_occurrences=0
stage_instruction_occurrences=0
stage_immutable_occurrences=0
stage_states=0
stage_source_instructions=0
stage_state_capacity_growths=0
stage_elf_capacity_growths=0
stage_normal_instruction_occurrences=0
stage_normal_instruction_classes=0
stage_normal_instruction_shared_occurrences=0
stage_normal_instruction_opened_bytes=0
stage_normal_instruction_class_bytes=0
stage_stored_normal_instruction_bytes=0
stage_normal_instruction_minimum_proofs=0
stage_normal_instruction_joint_witnesses=0
stage_normal_instruction_work_lower_bound_sum=0
stage_normal_instruction_span_lower_bound_sum=0
stage_normal_instruction_maximum_work_lower_bound=0
stage_normal_instruction_maximum_span_lower_bound=0
stage_checked_successor_coordinates=0
stage_stored_residual_state_rows=0
stage_stored_residual_edge_rows=0
stage_future_classes=0
stage_opened_elf_bytes=0
stage_unique_fragment_bytes=0
stage_canonical_byte_extent=0
stage_archive_count=0
stage_archive_member_occurrences=0
stage_archive_symbol_occurrences=0
stage_generated_archive_bytes=0
stage_external_payload_occurrences=0
stage_external_payload_bytes=0
stage_namespace_paths=0
stage_namespace_inodes=0
stage_namespace_hardlink_aliases=0
stage_namespace_material_occurrences=0
stage_namespace_opened_path_bytes=0
stage_namespace_retained_basename_bytes=0
stage_namespace_topology_bits=0
stage_namespace_descriptor_bytes=0
stage_factor_bits=0
stage_factor_bytes=0
stage_factor_workspace_bytes=0
stage_factor_gap_bits=0
archive_inodes=0
archive_hardlinks=0
archive_logical_source_bytes=0
archive_logical_normalized_bytes=0
archive_unique_source_bytes=0
archive_unique_normalized_bytes=0
for relative in "${linked_paths[@]}"; do
  source="$input/$relative"
  target="$partial/$relative"
  inode=${inode_by_path[$relative]}
  source_size=${size_by_path[$relative]}
  logical_source_bytes=$((logical_source_bytes + source_size))
  if [[ -n ${optimized_inode[$inode]+present} ]]; then
    alias_owner[$relative]=${optimized_inode[$inode]}
    alias_paths+=("$relative")
    hardlinks=$((hardlinks + 1))
    continue
  fi
  source_identity=$(sha256sum "$source" | cut -d' ' -f1)
  if [[ -z ${source_digest_seen[$source_identity]+present} ]]; then
    source_digest_seen[$source_identity]=1
    canonical_source_bytes=$((canonical_source_bytes + source_size))
    source_objects=$((source_objects + 1))
  fi

  input_inodes=$((input_inodes + 1))
  optimized_inode[$inode]=$relative
  unique_paths+=("$relative")
  stage_arguments+=("$source" "$target")
done

for relative in "${archive_paths[@]}"; do
  source="$input/$relative"
  target="$partial/$relative"
  inode=${inode_by_path[$relative]}
  source_size=${size_by_path[$relative]}
  archive_logical_source_bytes=$((archive_logical_source_bytes + source_size))
  if [[ -n ${normalized_archive_inode[$inode]+present} ]]; then
    archive_alias_owner[$relative]=${normalized_archive_inode[$inode]}
    archive_alias_paths+=("$relative")
    archive_hardlinks=$((archive_hardlinks + 1))
    continue
  fi
  normalized_archive_inode[$inode]=$relative
  archive_inodes=$((archive_inodes + 1))
  archive_unique_source_bytes=$((archive_unique_source_bytes + source_size))
  temporary_archive="$target.normalized.$$"
  "$archive_normalizer" "$source" "$temporary_archive" >/dev/null
  chmod --reference="$source" "$temporary_archive"
  mv -- "$temporary_archive" "$target"
  archive_stage_arguments+=("$target")
  normalized_size=$(stat -c %s -- "$target")
  archive_logical_normalized_bytes=$((
    archive_logical_normalized_bytes + normalized_size
  ))
  archive_unique_normalized_bytes=$((
    archive_unique_normalized_bytes + normalized_size
  ))
done

for relative in "${archive_alias_paths[@]}"; do
  target="$partial/$relative"
  canonical="$partial/${archive_alias_owner[$relative]}"
  rm -f -- "$target"
  ln -- "$canonical" "$target"
  archive_logical_normalized_bytes=$((
    archive_logical_normalized_bytes + $(stat -c %s -- "$canonical")
  ))
done

if (( input_inodes != 0 )); then
  "$stage" --stage "$stage_report" \
    --namespace-root "$input" --payload-root "$partial" \
    --archives "${#archive_stage_arguments[@]}" \
    "${archive_stage_arguments[@]}" \
    --payloads "${#external_payload_stage_arguments[@]}" \
    "${external_payload_stage_arguments[@]}" --elfs \
    "${stage_arguments[@]}"
  stage_processes=1
  grep -qxF 'format=artifact-executable-stage-v13' "$stage_report"
  grep -qxF "optimized_elfs=$input_inodes" "$stage_report"
  while IFS='=' read -r key value; do
    case $key in
      complete_gate) stage_complete_gate=$value ;;
      semantic_family_mask) stage_semantic_family_mask=$value ;;
      block_occurrences) stage_block_occurrences=$value ;;
      slice_occurrences) stage_slice_occurrences=$value ;;
      instruction_occurrences) stage_instruction_occurrences=$value ;;
      immutable_occurrences) stage_immutable_occurrences=$value ;;
      states) stage_states=$value ;;
      source_instructions) stage_source_instructions=$value ;;
      state_capacity_growths) stage_state_capacity_growths=$value ;;
      elf_capacity_growths) stage_elf_capacity_growths=$value ;;
      normal_instruction_occurrences) \
        stage_normal_instruction_occurrences=$value ;;
      normal_instruction_classes) stage_normal_instruction_classes=$value ;;
      normal_instruction_shared_occurrences) \
        stage_normal_instruction_shared_occurrences=$value ;;
      normal_instruction_opened_bytes) \
        stage_normal_instruction_opened_bytes=$value ;;
      normal_instruction_class_bytes) \
        stage_normal_instruction_class_bytes=$value ;;
      stored_normal_instruction_bytes) \
        stage_stored_normal_instruction_bytes=$value ;;
      normal_instruction_minimum_proofs) \
        stage_normal_instruction_minimum_proofs=$value ;;
      normal_instruction_joint_witnesses) \
        stage_normal_instruction_joint_witnesses=$value ;;
      normal_instruction_work_lower_bound_sum) \
        stage_normal_instruction_work_lower_bound_sum=$value ;;
      normal_instruction_span_lower_bound_sum) \
        stage_normal_instruction_span_lower_bound_sum=$value ;;
      normal_instruction_maximum_work_lower_bound) \
        stage_normal_instruction_maximum_work_lower_bound=$value ;;
      normal_instruction_maximum_span_lower_bound) \
        stage_normal_instruction_maximum_span_lower_bound=$value ;;
      checked_successor_coordinates) \
        stage_checked_successor_coordinates=$value ;;
      stored_residual_state_rows) stage_stored_residual_state_rows=$value ;;
      stored_residual_edge_rows) stage_stored_residual_edge_rows=$value ;;
      future_classes) stage_future_classes=$value ;;
      opened_elf_bytes) stage_opened_elf_bytes=$value ;;
      unique_fragment_bytes) stage_unique_fragment_bytes=$value ;;
      canonical_byte_extent) stage_canonical_byte_extent=$value ;;
      archive_count) stage_archive_count=$value ;;
      archive_member_occurrences) stage_archive_member_occurrences=$value ;;
      archive_symbol_occurrences) stage_archive_symbol_occurrences=$value ;;
      generated_archive_bytes) stage_generated_archive_bytes=$value ;;
      external_payload_occurrences) \
        stage_external_payload_occurrences=$value ;;
      external_payload_bytes) stage_external_payload_bytes=$value ;;
      namespace_paths) stage_namespace_paths=$value ;;
      namespace_inodes) stage_namespace_inodes=$value ;;
      namespace_hardlink_aliases) \
        stage_namespace_hardlink_aliases=$value ;;
      namespace_material_occurrences) \
        stage_namespace_material_occurrences=$value ;;
      namespace_opened_path_bytes) \
        stage_namespace_opened_path_bytes=$value ;;
      namespace_retained_basename_bytes) \
        stage_namespace_retained_basename_bytes=$value ;;
      namespace_topology_bits) stage_namespace_topology_bits=$value ;;
      namespace_descriptor_bytes) stage_namespace_descriptor_bytes=$value ;;
      factor_bits) stage_factor_bits=$value ;;
      factor_bytes) stage_factor_bytes=$value ;;
      factor_workspace_bytes) stage_factor_workspace_bytes=$value ;;
      factor_gap_bits) stage_factor_gap_bits=$value ;;
    esac
  done <"$stage_report"
  for value in "$stage_complete_gate" "$stage_semantic_family_mask" \
      "$stage_block_occurrences" "$stage_slice_occurrences" \
      "$stage_instruction_occurrences" "$stage_immutable_occurrences" \
      "$stage_states" "$stage_source_instructions" \
      "$stage_state_capacity_growths" \
      "$stage_elf_capacity_growths" \
      "$stage_normal_instruction_occurrences" \
      "$stage_normal_instruction_classes" \
      "$stage_normal_instruction_shared_occurrences" \
      "$stage_normal_instruction_opened_bytes" \
      "$stage_normal_instruction_class_bytes" \
      "$stage_stored_normal_instruction_bytes" \
      "$stage_normal_instruction_minimum_proofs" \
      "$stage_normal_instruction_joint_witnesses" \
      "$stage_normal_instruction_work_lower_bound_sum" \
      "$stage_normal_instruction_span_lower_bound_sum" \
      "$stage_normal_instruction_maximum_work_lower_bound" \
      "$stage_normal_instruction_maximum_span_lower_bound" \
      "$stage_checked_successor_coordinates" \
      "$stage_stored_residual_state_rows" \
      "$stage_stored_residual_edge_rows" \
      "$stage_future_classes" "$stage_opened_elf_bytes" \
      "$stage_unique_fragment_bytes" "$stage_factor_bits" \
      "$stage_canonical_byte_extent" \
      "$stage_archive_count" "$stage_archive_member_occurrences" \
      "$stage_archive_symbol_occurrences" \
      "$stage_generated_archive_bytes" \
      "$stage_external_payload_occurrences" \
      "$stage_external_payload_bytes" \
      "$stage_namespace_paths" "$stage_namespace_inodes" \
      "$stage_namespace_hardlink_aliases" \
      "$stage_namespace_material_occurrences" \
      "$stage_namespace_opened_path_bytes" \
      "$stage_namespace_retained_basename_bytes" \
      "$stage_namespace_topology_bits" \
      "$stage_namespace_descriptor_bytes" \
      "$stage_factor_bytes" "$stage_factor_workspace_bytes" \
      "$stage_factor_gap_bits"; do
    [[ $value =~ ^[0-9]+$ ]] || {
      printf 'invalid executable-stage report value: %q\n' "$value" >&2
      exit 1
    }
  done
  if (( stage_complete_gate != 1 || stage_semantic_family_mask != 63
        || stage_block_occurrences != stage_states
        || stage_slice_occurrences != 0
        || stage_instruction_occurrences != 0
        || stage_immutable_occurrences == 0
        || stage_normal_instruction_occurrences != stage_states
        || stage_normal_instruction_classes == 0
        || stage_normal_instruction_classes \
           + stage_normal_instruction_shared_occurrences \
           != stage_normal_instruction_occurrences
        || stage_normal_instruction_opened_bytes == 0
        || stage_normal_instruction_class_bytes == 0
        || stage_normal_instruction_class_bytes \
           > stage_normal_instruction_opened_bytes
        || stage_stored_normal_instruction_bytes != 0
        || stage_normal_instruction_minimum_proofs != stage_states
        || stage_normal_instruction_joint_witnesses > stage_states
        || stage_checked_successor_coordinates != stage_states * 2
        || stage_stored_residual_state_rows != 0
        || stage_stored_residual_edge_rows != 0
        || stage_future_classes == 0
        || stage_future_classes > stage_states
        || stage_canonical_byte_extent == 0
        || stage_namespace_paths == 0
        || stage_namespace_inodes == 0
        || stage_namespace_material_occurrences == 0
        || stage_archive_count != archive_inodes
        || stage_external_payload_occurrences \
           != ${#external_payload_stage_arguments[@]}
        || (${#external_payload_stage_arguments[@]} != 0 \
            && stage_external_payload_bytes == 0)
        || (stage_archive_count != 0
            && stage_generated_archive_bytes == 0) )); then
    printf 'executable stage did not close its complete population\n' >&2
    exit 1
  fi
  if (( stage_factor_gap_bits != 0 )); then
    printf 'executable stage left an unresolved factor gap\n' >&2
    exit 1
  fi
  if (( stage_factor_bytes != (stage_factor_bits + 7) / 8 )); then
    printf 'executable stage factor extent is inconsistent\n' >&2
    exit 1
  fi
fi

for relative in "${unique_paths[@]}"; do
  source="$input/$relative"
  target="$partial/$relative"
  "$verify" "$source" "$target"
  target_size=$(stat -c %s -- "$target")
  target_identity=$(sha256sum "$target" | cut -d' ' -f1)
  logical_optimized_bytes=$((logical_optimized_bytes + target_size))
  if [[ -z ${optimized_digest_seen[$target_identity]+present} ]]; then
    optimized_digest_seen[$target_identity]=1
    canonical_optimized_bytes=$((canonical_optimized_bytes + target_size))
    optimized_objects=$((optimized_objects + 1))
  fi
  is_linked_x86 "$target" || {
    printf 'post-link output is not a linked x86 ELF: /%s\n' "$relative" >&2
    exit 1
  }
  "$verify" "$target" >/dev/null
done

for relative in "${alias_paths[@]}"; do
  target="$partial/$relative"
  canonical="$partial/${alias_owner[$relative]}"
  rm -f -- "$target"
  ln -- "$canonical" "$target"
  logical_optimized_bytes=$((
    logical_optimized_bytes + $(stat -c %s -- "$canonical")
  ))
done

mv -- "$partial" "$output"
rm -f -- "$regular_list"
trap - EXIT HUP INT TERM
report=${POSTLINK_PAYLOAD_REPORT:-$output.postlink-report}
{
  printf 'format=optimized-payload-report-v12\n'
  printf 'executable_stage_identity=%s\n' "$stage_identity"
  printf 'complete_gate=%u\n' "$stage_complete_gate"
  printf 'semantic_family_mask=%u\n' "$stage_semantic_family_mask"
  printf 'block_occurrences=%u\n' "$stage_block_occurrences"
  printf 'slice_occurrences=%u\n' "$stage_slice_occurrences"
  printf 'instruction_occurrences=%u\n' "$stage_instruction_occurrences"
  printf 'immutable_occurrences=%u\n' "$stage_immutable_occurrences"
  printf 'linked_paths=%u\n' "${#linked_paths[@]}"
  printf 'input_inodes=%u\n' "$input_inodes"
  printf 'hardlink_aliases=%u\n' "$hardlinks"
  printf 'stage_processes=%u\n' "$stage_processes"
  printf 'compiler_calls=%u\n' "$input_inodes"
  printf 'semantic_states=%u\n' "$stage_states"
  printf 'source_instructions=%u\n' "$stage_source_instructions"
  printf 'state_capacity_growths=%u\n' "$stage_state_capacity_growths"
  printf 'elf_capacity_growths=%u\n' "$stage_elf_capacity_growths"
  printf 'normal_instruction_occurrences=%u\n' \
    "$stage_normal_instruction_occurrences"
  printf 'normal_instruction_classes=%u\n' \
    "$stage_normal_instruction_classes"
  printf 'normal_instruction_shared_occurrences=%u\n' \
    "$stage_normal_instruction_shared_occurrences"
  printf 'normal_instruction_opened_bytes=%u\n' \
    "$stage_normal_instruction_opened_bytes"
  printf 'normal_instruction_class_bytes=%u\n' \
    "$stage_normal_instruction_class_bytes"
  printf 'stored_normal_instruction_bytes=%u\n' \
    "$stage_stored_normal_instruction_bytes"
  printf 'normal_instruction_minimum_proofs=%u\n' \
    "$stage_normal_instruction_minimum_proofs"
  printf 'normal_instruction_joint_witnesses=%u\n' \
    "$stage_normal_instruction_joint_witnesses"
  printf 'normal_instruction_work_lower_bound_sum=%u\n' \
    "$stage_normal_instruction_work_lower_bound_sum"
  printf 'normal_instruction_span_lower_bound_sum=%u\n' \
    "$stage_normal_instruction_span_lower_bound_sum"
  printf 'normal_instruction_maximum_work_lower_bound=%u\n' \
    "$stage_normal_instruction_maximum_work_lower_bound"
  printf 'normal_instruction_maximum_span_lower_bound=%u\n' \
    "$stage_normal_instruction_maximum_span_lower_bound"
  printf 'checked_successor_coordinates=%u\n' \
    "$stage_checked_successor_coordinates"
  printf 'stored_residual_state_rows=%u\n' \
    "$stage_stored_residual_state_rows"
  printf 'stored_residual_edge_rows=%u\n' \
    "$stage_stored_residual_edge_rows"
  printf 'complete_future_classes=%u\n' "$stage_future_classes"
  printf 'opened_elf_bytes=%u\n' "$stage_opened_elf_bytes"
  printf 'unique_fragment_bytes=%u\n' "$stage_unique_fragment_bytes"
  printf 'canonical_byte_extent=%u\n' "$stage_canonical_byte_extent"
  printf 'complete_archive_count=%u\n' "$stage_archive_count"
  printf 'archive_member_occurrences=%u\n' \
    "$stage_archive_member_occurrences"
  printf 'archive_symbol_occurrences=%u\n' \
    "$stage_archive_symbol_occurrences"
  printf 'generated_archive_bytes=%u\n' "$stage_generated_archive_bytes"
  printf 'external_payload_occurrences=%u\n' \
    "$stage_external_payload_occurrences"
  printf 'external_payload_bytes=%u\n' "$stage_external_payload_bytes"
  printf 'namespace_paths=%u\n' "$stage_namespace_paths"
  printf 'namespace_inodes=%u\n' "$stage_namespace_inodes"
  printf 'namespace_hardlink_aliases=%u\n' \
    "$stage_namespace_hardlink_aliases"
  printf 'namespace_material_occurrences=%u\n' \
    "$stage_namespace_material_occurrences"
  printf 'namespace_opened_path_bytes=%u\n' \
    "$stage_namespace_opened_path_bytes"
  printf 'namespace_retained_basename_bytes=%u\n' \
    "$stage_namespace_retained_basename_bytes"
  printf 'namespace_topology_bits=%u\n' "$stage_namespace_topology_bits"
  printf 'namespace_descriptor_bytes=%u\n' \
    "$stage_namespace_descriptor_bytes"
  printf 'factor_bits=%u\n' "$stage_factor_bits"
  printf 'factor_bytes=%u\n' "$stage_factor_bytes"
  printf 'factor_workspace_bytes=%u\n' "$stage_factor_workspace_bytes"
  printf 'factor_gap_bits=%u\n' "$stage_factor_gap_bits"
  printf 'archive_paths=%u\n' "${#archive_paths[@]}"
  printf 'archive_inodes=%u\n' "$archive_inodes"
  printf 'archive_hardlink_aliases=%u\n' "$archive_hardlinks"
  printf 'archive_logical_source_bytes=%u\n' \
    "$archive_logical_source_bytes"
  printf 'archive_logical_normalized_bytes=%u\n' \
    "$archive_logical_normalized_bytes"
  printf 'archive_unique_source_bytes=%u\n' "$archive_unique_source_bytes"
  printf 'archive_unique_normalized_bytes=%u\n' \
    "$archive_unique_normalized_bytes"
  printf 'source_elf_objects=%u\n' "$source_objects"
  printf 'optimized_elf_objects=%u\n' "$optimized_objects"
  printf 'logical_source_elf_bytes=%u\n' "$logical_source_bytes"
  printf 'logical_optimized_elf_bytes=%u\n' "$logical_optimized_bytes"
  printf 'canonical_source_elf_bytes=%u\n' "$canonical_source_bytes"
  printf 'canonical_optimized_elf_bytes=%u\n' \
    "$canonical_optimized_bytes"
} >"$report"
rm -f -- "$stage_report"
printf '%s\n' \
  "optimized payload: green (${#linked_paths[@]} paths, $input_inodes inodes)" \
  "canonical ELF: $source_objects/$canonical_source_bytes -> $optimized_objects/$canonical_optimized_bytes objects/bytes" \
  "logical aliases: $logical_source_bytes -> $logical_optimized_bytes bytes"
