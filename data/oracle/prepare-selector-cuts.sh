#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && ! -e $1 ]] || { printf 'usage: %s NEW-OUTPUT-DIRECTORY\n' "$0" >&2; exit 2; }
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p -- "$1/register" "$1/memory"
output=$(cd -- "$1" && pwd)
make -C "$repo/src/v2/wasm-compiler" all build/cut-check build/memory-cut-check fixture-tools
emit() {
  local directory=$1 name=$2 checker=$3
  shift 3
  local prefix="$output/$directory/$name"
  "${CC:-cc}" -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs "$@" \
    "$repo/src/v2/wasm-compiler/check/selector-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/$checker" "$prefix.optimized.elf" "$prefix"
}
rank=0
for segment in {0..5}; do
  for width in 16 32 64; do for extended in 0 1; do
    emit register "selector-$segment-$width-$extended" cut-check \
      -DSELECTOR_RANK="$segment" -DSELECTOR_WIDTH="$width" -DSELECTOR_EXTENDED="$extended"
  done; done
  for prefix in 0 1 2; do for address in 32 64; do
    emit memory "memory-$rank" memory-cut-check -DSELECTOR_MEMORY=1 -DSELECTOR_RANK="$segment" \
      -DSELECTOR_PREFIX="$prefix" -DSELECTOR_ADDRESS="$address"
    rank=$((rank+1))
  done; done
done
for case in 1 2 3; do
  emit memory "memory-$rank" memory-cut-check -DSELECTOR_MEMORY=1 -DSELECTOR_RANK=2 -DSELECTOR_CASE="$case"
  rank=$((rank+1))
done
printf 'Visible selector native observations prepared; execute direct/C-dispatch and C-MMU comparisons.\n'
