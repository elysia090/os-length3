#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# != 4 ]]; then
  printf 'usage: %s SOURCE-ROOT OPTIMIZED-ROOT NATIVE-BENCHMARK REPORT\n' \
    "$0" >&2
  exit 2
fi

source_root=${1%/}
optimized_root=${2%/}
benchmark=$3
report=$4
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(cd -- "$here/../.." && pwd)
manifest=$here/postlink-workloads.tsv
. "$here/profile.env"

for directory in "$source_root" "$optimized_root"; do
  if [[ ! -d $directory ]]; then
    printf 'benchmark root does not exist: %s\n' "$directory" >&2
    exit 2
  fi
done
if [[ ! -x $benchmark ]]; then
  printf 'native benchmark does not exist: %s\n' "$benchmark" >&2
  exit 2
fi
if [[ ! -f $manifest ]]; then
  printf 'fixed workload manifest does not exist: %s\n' "$manifest" >&2
  exit 2
fi
if [[ $(head -n 1 -- "$manifest") != format=native-postlink-workloads-v1 ]]; then
  printf 'fixed workload manifest has an unknown schema\n' >&2
  exit 2
fi

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$temporary/home" "$temporary/tmp"
cd -- "$repository"

if ! command -v taskset >/dev/null; then
  printf 'production comparison requires taskset CPU affinity\n' >&2
  exit 1
fi
allowed_cpus=$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' \
  /proc/self/status)
benchmark_cpu=${allowed_cpus%%,*}
benchmark_cpu=${benchmark_cpu%%-*}
if [[ ! $benchmark_cpu =~ ^[0-9]+$ ]]; then
  printf 'cannot select one allowed CPU from: %s\n' "$allowed_cpus" >&2
  exit 1
fi
fixed_environment=(
  env -i
  LC_ALL=C LANG=C TZ=UTC
  PATH=/usr/bin:/bin
  HOME="$temporary/home"
  TMPDIR="$temporary/tmp"
)

source_population=$temporary/source.population
optimized_population=$temporary/optimized.population
bash "$here/measure-root.sh" "$source_root" "$source_population"
bash "$here/measure-root.sh" "$optimized_root" "$optimized_population"
source_bytes=$(sed -n 's/^canonical_filesystem_bytes=//p' \
  "$source_population")
optimized_bytes=$(sed -n 's/^canonical_filesystem_bytes=//p' \
  "$optimized_population")
if [[ ! $source_bytes =~ ^[0-9]+$ || ! $optimized_bytes =~ ^[0-9]+$ ]]; then
  printf 'canonical filesystem measurement is incomplete\n' >&2
  exit 1
fi
if (( optimized_bytes >= source_bytes )); then
  printf 'canonical filesystem did not shrink: %s -> %s bytes\n' \
    "$source_bytes" "$optimized_bytes" >&2
  exit 1
fi

rows=$temporary/workloads
: >"$rows"
declare -A seen=()
workload_count=0
weight_total=0
while IFS= read -r line; do
  [[ -n $line ]] || continue
  IFS=$'\t' read -r -a fields <<<"$line"
  if (( ${#fields[@]} < 4 )); then
    printf 'invalid fixed workload row: %s\n' "$line" >&2
    exit 1
  fi
  id=${fields[0]}
  weight=${fields[1]}
  relative=${fields[2]}
  argv0=${fields[3]}
  if [[ ! $id =~ ^[a-z0-9][a-z0-9-]*$ || ! $weight =~ ^[1-9][0-9]*$ \
      || $relative == /* || $relative == *..* ]]; then
    printf 'invalid fixed workload identity: %s\n' "$line" >&2
    exit 1
  fi
  if [[ -n ${seen[$id]+present} ]]; then
    printf 'duplicate fixed workload identity: %s\n' "$id" >&2
    exit 1
  fi
  seen[$id]=1
  source_executable=$source_root/$relative
  optimized_executable=$optimized_root/$relative
  if [[ ! -x $source_executable || ! -x $optimized_executable ]]; then
    printf 'fixed workload executable is missing: %s\n' "$relative" >&2
    exit 1
  fi
  arguments=("$argv0")
  for ((index = 4; index < ${#fields[@]}; ++index)); do
    argument=${fields[$index]//@REPOSITORY@/$repository}
    arguments+=("$argument")
  done
  result=$temporary/$id.result
  taskset -c "$benchmark_cpu" "${fixed_environment[@]}" \
    "$benchmark" "$source_executable" "$optimized_executable" \
      "${arguments[@]}" >"$result"
  if [[ $(sed -n 's/^format=//p' "$result") \
        != native-paired-benchmark-v1 \
      || $(sed -n 's/^paired_samples=//p' "$result") != 401 \
      || $(sed -n 's/^warmups=//p' "$result") != 8 \
      || $(sed -n 's/^parity=//p' "$result") != green ]]; then
    printf 'fixed workload result is not a production record: %s\n' \
      "$id" >&2
    exit 1
  fi
  source_mean=$(sed -n 's/^source_mean_ns=//p' "$result")
  optimized_mean=$(sed -n 's/^optimized_mean_ns=//p' "$result")
  source_median=$(sed -n 's/^source_median_ns=//p' "$result")
  optimized_median=$(sed -n 's/^optimized_median_ns=//p' "$result")
  ratio=$(sed -n 's/^mean_ratio=//p' "$result")
  if [[ ! $source_mean =~ ^[0-9]+$ || ! $optimized_mean =~ ^[0-9]+$ \
      || ! $source_median =~ ^[0-9]+$ \
      || ! $optimized_median =~ ^[0-9]+$ \
      || ! $ratio =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf 'fixed workload timing is incomplete: %s\n' "$id" >&2
    exit 1
  fi
  source_identity=$(sha256sum "$source_executable" | cut -d' ' -f1)
  optimized_identity=$(sha256sum "$optimized_executable" | cut -d' ' -f1)
  source_extent=$(stat -c %s -- "$source_executable")
  optimized_extent=$(stat -c %s -- "$optimized_executable")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$id" "$weight" "$source_mean" "$optimized_mean" \
    "$source_median" "$optimized_median" "$source_identity" \
    "$optimized_identity" "$source_extent" "$optimized_extent" >>"$rows"
  workload_count=$((workload_count + 1))
  weight_total=$((weight_total + weight))
done < <(tail -n +2 -- "$manifest")

if (( workload_count == 0 || weight_total == 0 )); then
  printf 'fixed workload manifest is empty\n' >&2
  exit 1
fi

read -r weighted_source weighted_optimized aggregate_ratio < <(
  awk -F '\t' '
    { source += $2 * $3; optimized += $2 * $4 }
    END {
      if (source <= 0 || optimized <= 0) exit 1
      printf "%.0f %.0f %.9f\n", source, optimized, optimized / source
    }
  ' "$rows"
)
if awk -v ratio="$aggregate_ratio" 'BEGIN { exit !(ratio >= 1.0) }'; then
  printf 'fixed native workload aggregate regressed: ratio=%s\n' \
    "$aggregate_ratio" >&2
  exit 1
fi

manifest_digest=$(sha256sum "$manifest" | cut -d' ' -f1)
sources_digest=$(sha256sum "$here/../sources.env" | cut -d' ' -f1)
profile_digest=$(sha256sum "$here/profile.env" | cut -d' ' -f1)
benchmark_digest=$(sha256sum "$benchmark" | cut -d' ' -f1)
temporary_report=$report.partial.$$
{
  printf 'format=postlink-production-comparison-v2\n'
  printf 'workload_manifest_sha256=%s\n' "$manifest_digest"
  printf 'sources_lock_sha256=%s\n' "$sources_digest"
  printf 'distribution_profile_sha256=%s\n' "$profile_digest"
  printf 'native_benchmark_sha256=%s\n' "$benchmark_digest"
  printf 'paired_samples_per_workload=401\n'
  printf 'warmups_per_workload=8\n'
  printf 'workloads=%u\n' "$workload_count"
  printf 'weight_total=%u\n' "$weight_total"
  printf 'source_canonical_filesystem_bytes=%s\n' "$source_bytes"
  printf 'optimized_canonical_filesystem_bytes=%s\n' "$optimized_bytes"
  printf 'artifact_release_target_bytes=%s\n' \
    "$DISTRIBUTION_RELEASE_MAX_BYTES"
  printf 'canonical_filesystem_ratio='
  awk -v source="$source_bytes" -v optimized="$optimized_bytes" \
    'BEGIN { printf "%.9f\n", optimized / source }'
  printf 'weighted_source_mean_ns=%s\n' "$weighted_source"
  printf 'weighted_optimized_mean_ns=%s\n' "$weighted_optimized"
  printf 'weighted_mean_ratio=%s\n' "$aggregate_ratio"
  printf 'benchmark_cpu=%s\n' "$benchmark_cpu"
  printf 'cpu_allowed_list=%s\n' "$allowed_cpus"
  governor=/sys/devices/system/cpu/cpu$benchmark_cpu/cpufreq/scaling_governor
  if [[ -r $governor ]]; then
    printf 'cpu_frequency_governor=%s\n' "$(<"$governor")"
  else
    printf 'cpu_frequency_governor=unavailable\n'
  fi
  if [[ -r /proc/cpuinfo ]]; then
    cpu_contract=$temporary/cpu-contract
    awk '
      BEGIN { keep["vendor_id"]; keep["cpu family"]; keep["model"];
              keep["stepping"]; keep["model name"]; keep["microcode"];
              keep["flags"] }
      /^$/ { exit }
      {
        key=$0; sub(/:.*/, "", key); sub(/[[:space:]]+$/, "", key)
        if (key in keep) print
      }
    ' /proc/cpuinfo >"$cpu_contract"
    printf 'cpu_contract_sha256=%s\n' \
      "$(sha256sum "$cpu_contract" | cut -d' ' -f1)"
  else
    printf 'cpu_contract_sha256=unavailable\n'
  fi
  printf 'uname='; uname -srvm | tr '\n' ' '; printf '\n'
  while IFS=$'\t' read -r id weight source_mean optimized_mean \
      source_median optimized_median source_identity optimized_identity \
      source_extent optimized_extent; do
    printf 'workload.%s.weight=%s\n' "$id" "$weight"
    printf 'workload.%s.source_mean_ns=%s\n' "$id" "$source_mean"
    printf 'workload.%s.optimized_mean_ns=%s\n' "$id" "$optimized_mean"
    printf 'workload.%s.source_median_ns=%s\n' "$id" "$source_median"
    printf 'workload.%s.optimized_median_ns=%s\n' \
      "$id" "$optimized_median"
    printf 'workload.%s.source_sha256=%s\n' "$id" "$source_identity"
    printf 'workload.%s.optimized_sha256=%s\n' \
      "$id" "$optimized_identity"
    printf 'workload.%s.source_bytes=%s\n' "$id" "$source_extent"
    printf 'workload.%s.optimized_bytes=%s\n' "$id" "$optimized_extent"
  done <"$rows"
} >"$temporary_report"
mv -- "$temporary_report" "$report"
printf 'post-link production comparison: green (%s -> %s bytes, ratio %s)\n' \
  "$source_bytes" "$optimized_bytes" "$aggregate_ratio"
