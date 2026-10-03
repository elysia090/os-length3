#!/usr/bin/env bash
# Full register/memory MUL/IMUL products through the common C compiler.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-implicit-multiply-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output/register" "$output/memory"
make -C "$repo/src/v2/wasm-compiler" all build/implicit-multiply-check build/memory-cut-check fixture-tools
"$repo/src/v2/wasm-compiler/build/implicit-multiply-check" "$output/register"
for rank in {281..326}; do
  prefix="$output/memory/memory-$rank"
  cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
    -DMEMORY_CASE="$rank" "$repo/src/v2/wasm-compiler/check/memory-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/memory-cut-check" "$prefix.optimized.elf" "$prefix"
done
