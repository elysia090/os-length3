#!/usr/bin/env bash
# Native x86 carry/load/RMW observations of accepted postlinked ELF bytes.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-memory-carry-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" all build/memory-cut-check fixture-tools
rank=327
for opcode in adc sbb; do for width in 8 16 32 64; do
  for form in {0..17}; do
    if [[ $width != 8 && ( $form == 12 || $form == 13 ) ]]; then continue; fi
    prefix="$output/memory-$rank"
    cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
      -DMEMORY_CARRY="$opcode" -DMEMORY_WIDTH="$width" -DMEMORY_CARRY_CASE="$form" \
      "$repo/src/v2/wasm-compiler/check/memory-carry-fixture.S" -o "$prefix.linked.elf"
    "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
    "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
    "$repo/src/v2/wasm-compiler/build/memory-cut-check" "$prefix.optimized.elf" "$prefix"
    rank=$((rank+1))
  done
done; done
test "$rank" = 459
