#!/usr/bin/env bash
# Native x86 is the oracle, not a multiplication reimplementation.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-multiply-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" all build/cut-check fixture-tools
for width in 16 32 64; do
  for variant in 0 1 2 3 4 5 6 7 8 9 10; do
    test "$variant" != 4 || test "$width" != 16 || continue
    prefix="$output/imul-$width-$variant"
    cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs -DCUT_MULTIPLY=1 \
      -DCUT_WIDTH="$width" -DCUT_MULTIPLY_CASE="$variant" \
      "$repo/src/v2/wasm-compiler/check/cut-fixture.S" -o "$prefix.linked.elf"
    "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
    "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
    "$repo/src/v2/wasm-compiler/build/cut-check" "$prefix.optimized.elf" "$prefix"
  done
done
