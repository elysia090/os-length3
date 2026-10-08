#!/usr/bin/env bash
set -euo pipefail
[[ $# -ge 1 && $# -le 2 && ! -e $1 ]] || { printf 'usage: %s NEW-OUTPUT-DIRECTORY [shift|rotate|carry-rotate]\n' "$0" >&2; exit 2; }
family=${2:-shift}
case $family in
  shift) opcodes=(shl shr sar); first=1; last=12;;
  rotate) opcodes=(rol ror); first=13; last=26;;
  carry-rotate) opcodes=(rcl rcr); first=27; last=34;;
  *) printf 'unknown shift family\n' >&2; exit 2;;
esac
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p -- "$1"
output=$(cd -- "$1" && pwd)
emit() {
  local name=$1
  shift
  "${CC:-cc}" -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs "$@" \
    "$repo/src/v2/wasm-compiler/check/shift-fixture.S" -o "$output/$name.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" \
    "$output/$name.linked.elf" -o "$output/$name.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" \
    "$output/$name.linked.elf" "$output/$name.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/cut-check" "$output/$name.optimized.elf" "$output/$name"
}
for opcode in "${opcodes[@]}"; do
  for width in 8 16 32 64; do
    emit "$opcode-$width-cl" -DSHIFT_OPCODE="$opcode" -DSHIFT_WIDTH="$width"
    for count in 0 1 7 8 9 10 15 16 17 18 31 32 63 64 255; do
      emit "$opcode-$width-$count" -DSHIFT_OPCODE="$opcode" -DSHIFT_WIDTH="$width" -DSHIFT_COUNT="$count"
    done
  done
done
for ((rank=first;rank<=last;++rank)); do emit "compose-$rank" -DSHIFT_CASE="$rank"; done
printf 'Native shift records prepared; execute both direct Wasm and C table comparisons.\n'
