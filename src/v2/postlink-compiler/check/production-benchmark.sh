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
for root in "$source_root" "$optimized_root"; do
  mkdir -p "$root/usr/share/misc"
  printf 'identical fixed resource\n' >"$root/usr/share/misc/magic.mgc"
done

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
grep -Eq '^workload_inputs_sha256=[0-9a-f]{64}$' "$report"
grep -q '^paired_samples_per_workload=401$' "$report"
grep -q '^weighted_mean_ratio=0.800000000$' "$report"
grep -qxF 'comparison=green' "$report"

sed 's/optimized_mean_ns=80/optimized_mean_ns=120/;s/mean_ratio=0.800000000/mean_ratio=1.200000000/' \
  "$mock" >"$temporary/slow-native-benchmark"
chmod +x "$temporary/slow-native-benchmark"
if bash "$runner" "$source_root" "$optimized_root" \
    "$temporary/slow-native-benchmark" "$temporary/slow-report" >/dev/null 2>&1; then
  printf 'production comparison accepted a runtime regression\n' >&2
  exit 1
fi
grep -qxF 'comparison=red-speed' "$temporary/slow-report"
grep -qxF 'weighted_mean_ratio=1.200000000' "$temporary/slow-report"

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

for name in source optimized; do
  printf '#!/bin/sh\nexit 1\n' >"$temporary/$name-fails"
  chmod +x "$temporary/$name-fails"
done
if "$native_benchmark" "$temporary/source-fails" \
    "$temporary/optimized-fails" failing >/dev/null 2>&1; then
  printf 'native benchmark accepted two identically failing programs\n' >&2
  exit 1
fi
for name in source optimized; do
  printf '#!/bin/sh\nif [ -e "$0.count" ]; then exit 1; fi\n: > "$0.count"\n' \
    >"$temporary/$name-intermittent"
  chmod +x "$temporary/$name-intermittent"
done
if "$native_benchmark" "$temporary/source-intermittent" \
    "$temporary/optimized-intermittent" intermittent >/dev/null 2>&1; then
  printf 'native benchmark accepted a failure after its parity probe\n' >&2
  exit 1
fi

printf '%s\n' 'int main(int argc, char **argv) {' \
  '  (void)argc;' '  return (unsigned char)argv[0][0] != 47u;' '}' \
  >"$temporary/argv0.c"
cc "$temporary/argv0.c" -o "$temporary/source-path"
cp -- "$temporary/source-path" "$temporary/optimized-path"
if ! "$native_benchmark" "$temporary/source-path" \
    "$temporary/optimized-path" @EXECUTABLE@ |
    grep -qxF 'wait_status=0'; then
  printf 'native benchmark did not project each executable path\n' >&2
  exit 1
fi

cat >"$temporary/resource.c" <<'EOF'
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    char expected[4096];
    const char *slash = strrchr(argv[0], '/');
    if (argc != 2 || !slash) return 1;
    int n = snprintf(expected, sizeof expected, "%.*s/resource",
                     (int)(slash - argv[0]), argv[0]);
    if (n < 0 || (size_t)n >= sizeof expected || strcmp(expected, argv[1])) return 2;
    FILE *input = fopen(argv[1], "r");
    if (!input) return 3;
    int value = fgetc(input);
    return fclose(input) || value != 42;
}
EOF
for name in source optimized; do
  mkdir "$temporary/$name-pair"
  cc "$temporary/resource.c" -o "$temporary/$name-pair/program"
  printf '*' >"$temporary/$name-pair/resource"
done
if ! "$native_benchmark" "$temporary/source-pair/program" \
    "$temporary/optimized-pair/program" @EXECUTABLE@ @EXECUTABLE_DIR@/resource |
    grep -qxF 'wait_status=0'; then
  printf 'native benchmark did not use each executable own package resource\n' >&2
  exit 1
fi

printf 'production benchmark recipe: green (fixed manifest, 401 pairs)\n'
