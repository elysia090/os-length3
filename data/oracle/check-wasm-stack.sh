#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || -e $1 ]]; then
  printf 'usage: %s NEW-OUTPUT-DIRECTORY\n' "$0" >&2
  exit 2
fi
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p -- "$1"
output=$(cd -- "$1" && pwd)
for rank in {0..10}; do
  prefix=$output/memory-$rank
  "${CC:-cc}" -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs -DSTACK_CASE="$rank" \
    "$repo/src/v2/wasm-compiler/check/stack-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/stack-cut-check" "$prefix.optimized.elf" "$prefix"
done
printf 'Native stack records: green; actual C-Wasm execution is a separate gate\n'
