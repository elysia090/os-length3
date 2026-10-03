#!/usr/bin/env bash
# Actual x86 register-destination memory ALU, including alias/width/address cases.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-memory-alu-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" all build/memory-cut-check fixture-tools
for rank in {62..87}; do
  prefix="$output/memory-$rank"
  cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
    -DMEMORY_CASE="$rank" "$repo/src/v2/wasm-compiler/check/memory-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/memory-cut-check" "$prefix.optimized.elf" "$prefix"
done
