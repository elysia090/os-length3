#!/usr/bin/env bash
# Register CMOV conditions/widths and interior flag consumers, not Linux boot.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-cmov-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" all build/cut-check fixture-tools
emit() {
  local name=$1; shift
  local prefix="$output/$name"
  cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs "$@" \
    "$repo/src/v2/wasm-compiler/check/cut-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/cut-check" "$prefix.optimized.elf" "$prefix"
}
for opcode in cmovo cmovno cmovb cmovae cmove cmovne cmovbe cmova cmovs cmovns cmovp cmovnp cmovl cmovge cmovle cmovg; do
  for width in 16 32 64; do
    emit "$opcode-$width" -DCUT_CMOV="$opcode" -DCUT_WIDTH="$width"
  done
done
for variant in 1 2 3; do
  emit "alias-frontier-$variant" -DCUT_CMOV=cmove -DCUT_WIDTH=32 -DCUT_CMOV_CASE="$variant"
done
