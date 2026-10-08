#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && ! -e $1 ]] || { printf 'usage: prepare-translate-cuts.sh NEW-OUTPUT-DIRECTORY\n' >&2;exit 2; }
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p -- "$1"
output=$(cd -- "$1" && pwd)
make -j4 -C "$repo/src/v2/wasm-compiler" all build/memory-cut-check fixture-tools
for address in 0 1;do for prefix in 0 0x66 0x48 0x41 0xf2 0xf3 0x64 0x65;do
    name="$output/xlat-$address-$prefix"
    cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs -DXLAT_ADDRESS32="$address" -DXLAT_PREFIX="$prefix" \
        "$repo/src/v2/wasm-compiler/check/translate-byte.S" -o "$name.linked.elf"
    "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$name.linked.elf" -o "$name.optimized.elf"
    "$repo/src/v2/optimized-x86/build/postlink-verify" "$name.linked.elf" "$name.optimized.elf"
    "$repo/src/v2/wasm-compiler/build/memory-cut-check" "$name.optimized.elf" "$name"
done;done
