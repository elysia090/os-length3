#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  printf 'usage: %s NATIVE-BENCHMARK\n' "$0" >&2
  exit 2
fi

native_benchmark=$1
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(cd -- "$here/../../../.." && pwd)
runner=$repository/data/distribution/benchmark-postlink.sh
manifest=$repository/data/distribution/postlink-workloads.tsv
temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

source_root=$temporary/source
optimized_root=$temporary/optimized
mkdir -p "$source_root" "$optimized_root"
while IFS= read -r line; do
  IFS=$'\t' read -r -a fields <<<"$line"
  relative=${fields[2]}
  mkdir -p "$source_root/$(dirname -- "$relative")" \
    "$optimized_root/$(dirname -- "$relative")"
  printf '#!/bin/sh\nprintf fixture-output\n# source padding source padding source padding source padding\n' \
    >"$source_root/$relative"
  printf '#!/bin/sh\nprintf fixture-output\n' \
    >"$optimized_root/$relative"
  chmod +x "$source_root/$relative" "$optimized_root/$relative"
done < <(tail -n +2 -- "$manifest")

mock=$temporary/native-benchmark
cat >"$mock" <<'EOF'
#!/bin/sh
printf '%s\n' \
  format=native-paired-benchmark-v1 \
  paired_samples=401 \
  warmups=8 \
  parity=green \
  wait_status=0 \
  output_bytes=14 \
  source_mean_ns=100 \
  source_median_ns=99 \
  optimized_mean_ns=80 \
  optimized_median_ns=79 \
  mean_ratio=0.800000000 \
  median_ratio=0.797979798
EOF
chmod +x "$mock"
report=$temporary/report
bash "$runner" "$source_root" "$optimized_root" "$mock" "$report"
grep -q '^format=postlink-production-comparison-v2$' "$report"
grep -q '^paired_samples_per_workload=401$' "$report"
grep -q '^weighted_mean_ratio=0.800000000$' "$report"

bad=$temporary/bad-native-benchmark
sed 's/paired_samples=401/paired_samples=400/' "$mock" >"$bad"
chmod +x "$bad"
if bash "$runner" "$source_root" "$optimized_root" "$bad" \
    "$temporary/bad-report" >/dev/null 2>&1; then
  printf 'production comparison accepted a non-fixed sample count\n' >&2
  exit 1
fi

# The real measurement binary also owns the fixed count. An obsolete RUNS
# argument must be parsed as a path and rejected before spawning 401 pairs.
if "$native_benchmark" 9 /does/not/exist argv0 >/dev/null 2>&1; then
  printf 'native benchmark accepted the obsolete variable-run interface\n' >&2
  exit 1
fi

printf 'production benchmark recipe: green (fixed manifest, 401 pairs)\n'
