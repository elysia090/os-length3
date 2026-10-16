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
source_root=$(realpath -e -- "$source_root")
optimized_root=$(realpath -e -- "$optimized_root")
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
input_rows=$temporary/workload-inputs
: >"$input_rows"
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
    if [[ ${fields[$index]} == *@REPOSITORY@* ]]; then
      if [[ $argument != "$repository"/* || ! -f $argument ]]; then
        printf 'missing fixed workload input: %s\n' "$argument" >&2
        exit 1
      fi
      printf '%s\t%s\t%s\n' "$id" "${argument#"$repository"/}" \
        "$(sha256sum "$argument" | cut -d' ' -f1)" >>"$input_rows"
    elif [[ $argument == @EXECUTABLE_DIR@/* ]]; then
      suffix=${argument#@EXECUTABLE_DIR@/}
      source_resource=$(realpath -e -- "${source_executable%/*}/$suffix")
      optimized_resource=$(realpath -e -- "${optimized_executable%/*}/$suffix")
      if [[ $source_resource != "$source_root"/* \
            || $optimized_resource != "$optimized_root"/* \
            || ! -f $source_resource || ! -f $optimized_resource ]] \
          || ! cmp -s -- "$source_resource" "$optimized_resource"; then
        printf 'fixed workload package resource is absent, escaping or different: %s\n' "$argument" >&2
        exit 1
      fi
      printf '%s\t%s\t%s\n' "$id" "${source_resource#"$source_root"/}" \
        "$(sha256sum "$source_resource" | cut -d' ' -f1)" >>"$input_rows"
    fi
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
  # What the 401 pairs can resolve: the paired ratio and its 95% interval.
  paired=$(sed -n 's/^wall_paired_ratio=//p' "$result")
  low=$(sed -n 's/^wall_ratio_low=//p' "$result")
  high=$(sed -n 's/^wall_ratio_high=//p' "$result")
  verdict=$(sed -n 's/^wall_verdict=//p' "$result")
  number='^[0-9]+([.][0-9]+)?$'
  if [[ ! $source_mean =~ ^[0-9]+$ || ! $optimized_mean =~ ^[0-9]+$ \
      || ! $source_median =~ ^[0-9]+$ \
      || ! $optimized_median =~ ^[0-9]+$ \
      || ! $ratio =~ $number || ! $paired =~ $number \
      || ! $low =~ $number || ! $high =~ $number \
      || ! $verdict =~ ^(faster|slower|within-noise)$ ]]; then
    printf 'fixed workload timing is incomplete: %s\n' "$id" >&2
    exit 1
  fi
  printf 'native workload %s: parity green, mean ratio %s, paired %s [%s, %s] %s\n' \
    "$id" "$ratio" "$paired" "$low" "$high" "$verdict"
  source_identity=$(sha256sum "$source_executable" | cut -d' ' -f1)
  optimized_identity=$(sha256sum "$optimized_executable" | cut -d' ' -f1)
  source_extent=$(stat -c %s -- "$source_executable")
  optimized_extent=$(stat -c %s -- "$optimized_executable")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$id" "$weight" "$source_mean" "$optimized_mean" \
    "$source_median" "$optimized_median" "$source_identity" \
    "$optimized_identity" "$source_extent" "$optimized_extent" \
    "$paired" "$low" "$high" "$verdict" >>"$rows"
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
# The aggregate the samples can resolve: each workload's paired log ratio,
# weighted by its share of the source time (as the mean above is), with the
# intervals combined as independent normal errors. Speed is red only when
# the whole interval lies above 1: a difference smaller than the machine's
# own run-to-run variation is reported as within-noise, not as a result.
read -r paired_ratio paired_low paired_high speed_verdict < <(
  awk -F '\t' '
    { w = $2 * $3; s = (log($13) - log($12)) / (2 * 1.959963985)
      total += w; mean += w * log($11); variance += w * w * s * s }
    END {
      if (total <= 0) exit 1
      m = mean / total; half = 1.959963985 * sqrt(variance) / total
      low = exp(m - half); high = exp(m + half)
      verdict = high < 1 ? "faster" : low > 1 ? "slower" : "within-noise"
      printf "%.9f %.9f %.9f %s\n", exp(m), low, high, verdict
    }
  ' "$rows"
)
comparison=green
if [[ $speed_verdict == slower ]]; then
  comparison=red-speed
fi

manifest_digest=$(sha256sum "$manifest" | cut -d' ' -f1)
workload_inputs_digest=$(sha256sum "$input_rows" | cut -d' ' -f1)
sources_digest=$(sha256sum "$here/../sources.env" | cut -d' ' -f1)
profile_digest=$(sha256sum "$here/profile.env" | cut -d' ' -f1)
benchmark_digest=$(sha256sum "$benchmark" | cut -d' ' -f1)
temporary_report=$report.partial.$$
{
  printf 'format=postlink-production-comparison-v2\n'
  printf 'comparison=%s\n' "$comparison"
  printf 'workload_manifest_sha256=%s\n' "$manifest_digest"
  printf 'workload_inputs_sha256=%s\n' "$workload_inputs_digest"
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
  printf 'weighted_paired_ratio=%s\n' "$paired_ratio"
  printf 'weighted_ratio_low=%s\n' "$paired_low"
  printf 'weighted_ratio_high=%s\n' "$paired_high"
  printf 'speed_verdict=%s\n' "$speed_verdict"
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
      source_extent optimized_extent paired low high verdict; do
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
    printf 'workload.%s.paired_ratio=%s\n' "$id" "$paired"
    printf 'workload.%s.ratio_low=%s\n' "$id" "$low"
    printf 'workload.%s.ratio_high=%s\n' "$id" "$high"
    printf 'workload.%s.verdict=%s\n' "$id" "$verdict"
  done <"$rows"
} >"$temporary_report"
mv -- "$temporary_report" "$report"
if [[ $comparison != green ]]; then
  printf 'fixed native workload aggregate regressed: paired ratio=%s [%s, %s]; evidence=%s\n' \
    "$paired_ratio" "$paired_low" "$paired_high" "$report" >&2
  exit 1
fi
printf 'post-link production comparison: green (%s -> %s bytes, speed %s: paired ratio %s [%s, %s])\n' \
  "$source_bytes" "$optimized_bytes" "$speed_verdict" "$paired_ratio" "$paired_low" "$paired_high"
