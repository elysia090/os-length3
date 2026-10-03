#!/usr/bin/env bash
# Memory conditional moves, including false conditions and address aliases.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-memory-cmov-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" all build/memory-cut-check fixture-tools
rank=0
for opcode in cmovo cmovno cmovb cmovae cmove cmovne cmovbe cmova cmovs cmovns cmovp cmovnp cmovl cmovge cmovle cmovg; do
  for width in 16 32 64; do
    prefix="$output/memory-$rank"
    cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
      -DMEMORY_CMOV="$opcode" -DMEMORY_WIDTH="$width" \
      "$repo/src/v2/wasm-compiler/check/memory-fixture.S" -o "$prefix.linked.elf"
    "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
    "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
    "$repo/src/v2/wasm-compiler/build/memory-cut-check" "$prefix.optimized.elf" "$prefix"
    rank=$((rank + 1))
  done
done
for variant in 1 2 3 4 5 6; do
  prefix="$output/memory-$rank"
  cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
    -DMEMORY_CMOV=cmove -DMEMORY_WIDTH=64 -DMEMORY_CMOV_CASE="$variant" \
    "$repo/src/v2/wasm-compiler/check/memory-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/memory-cut-check" "$prefix.optimized.elf" "$prefix"
  rank=$((rank + 1))
done
