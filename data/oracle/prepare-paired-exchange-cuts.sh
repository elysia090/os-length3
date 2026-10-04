#!/usr/bin/env bash
# Independently post-linked ordinary ELF proof must emit the same paired SSA.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-paired-exchange-cuts.sh NEW-OUTPUT-DIRECTORY [--built]}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output/raw" "$output/elf" "$output/accepted"
if [[ ${2:-} != --built ]]; then
  make -C "$repo/src/v2/wasm-compiler" all build/paired-exchange-check fixture-tools
fi
"$repo/src/v2/wasm-compiler/build/paired-exchange-check" "$output/raw"
for rank in {0..71}; do
  prefix="$output/elf/paired-exchange-$rank"
  size=$(sed -n 's/.*"sourceBytes":\([0-9]*\).*/\1/p' "$output/raw/paired-exchange-$rank.json")
  test -n "$size"
  printf '.text\n.global _start\n_start:\n.incbin "%s",0,%s\nret\n' \
    "$(realpath -- "$output/raw/paired-exchange-$rank.source-page")" "$size" |
    cc -x assembler -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs,-Ttext=0x400000 - -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
done
"$repo/src/v2/wasm-compiler/build/paired-exchange-check" "$output/accepted" --elf "$output/elf"
