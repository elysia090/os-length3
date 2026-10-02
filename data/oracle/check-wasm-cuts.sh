#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  printf 'usage: %s NEW-OUTPUT-DIRECTORY\n' "$0" >&2
  exit 2
fi
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
output=$1
[[ ! -e $output ]] || { printf 'output already exists\n' >&2; exit 2; }
mkdir -p -- "$output"
output=$(cd -- "$output" && pwd)
cc=${CC:-cc}
compiler=$repo/src/v2/postlink-compiler/build/postlink-compiler
verify=$repo/src/v2/optimized-x86/build/postlink-verify
check=$repo/src/v2/wasm-compiler/build/cut-check
fixture=$repo/src/v2/wasm-compiler/check/cut-fixture.S

emit() {
  local name=$1
  shift
  "$cc" -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs "$@" "$fixture" \
    -o "$output/$name.linked.elf"
  "$compiler" "$output/$name.linked.elf" -o "$output/$name.optimized.elf"
  "$verify" "$output/$name.linked.elf" "$output/$name.optimized.elf"
  "$check" "$output/$name.optimized.elf" "$output/$name"
}
emit composed
for opcode in add sub and or xor cmp test inc dec neg not; do
  for width in 8 16 32 64; do
    args=(-DCUT_OPCODE="$opcode" -DCUT_WIDTH="$width")
    case $opcode in inc|dec|neg|not) args+=(-DCUT_UNARY=1);; esac
    emit "$opcode-$width" "${args[@]}"
  done
done
for rank in {1..21}; do emit "special-$rank" -DCUT_SPECIAL="$rank"; done
for opcode in jo jno jb jae je jne jbe ja js jns jp jnp jl jge jle jg; do
  emit "branch-$opcode" -DCUT_BRANCH="$opcode"
done
printf 'Native oracle records: green; run check-wasm-cuts.mjs for Wasm comparison\n'
