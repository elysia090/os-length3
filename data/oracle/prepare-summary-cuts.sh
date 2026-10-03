#!/usr/bin/env bash
# Fixed-profile scan/count cuts; prefixed legacy forms use a native ISA twin.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-summary-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" all build/cut-check fixture-tools
for kind in {0..4}; do for width in 16 32 64; do for variant in {0..4}; do
  prefix="$output/summary-$kind-$width-$variant"
  cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
    -DSUMMARY_KIND="$kind" -DSUMMARY_WIDTH="$width" -DSUMMARY_CASE="$variant" \
    "$repo/src/v2/wasm-compiler/check/summary-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  limit=64
  if [ "$variant" = 2 ]; then limit=1; fi
  "$repo/src/v2/wasm-compiler/build/cut-check" "$prefix.optimized.elf" "$prefix" "$limit"
done; done; done
