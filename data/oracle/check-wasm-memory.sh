#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || -e $1 ]]; then
  printf 'usage: %s NEW-OUTPUT-DIRECTORY\n' "$0" >&2
  exit 2
fi
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p -- "$1"
output=$(cd -- "$1" && pwd)
cc=${CC:-cc}
compiler=$repo/src/v2/postlink-compiler/build/postlink-compiler
verify=$repo/src/v2/optimized-x86/build/postlink-verify
check=$repo/src/v2/wasm-compiler/build/memory-cut-check
for rank in {0..21}; do
  prefix=$output/memory-$rank
  "$cc" -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs -DMEMORY_CASE="$rank" \
    "$repo/src/v2/wasm-compiler/check/memory-fixture.S" -o "$prefix.linked.elf"
  "$compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$check" "$prefix.optimized.elf" "$prefix"
done
printf 'Memory cut native records: green; Node execution is a separate gate\n'
