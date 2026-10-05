#!/usr/bin/env bash
# Native x86 observations and current independent C emissions from normal ELF.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-branch-cuts.sh NEW-OUTPUT-DIRECTORY COMPILER-BUILD}
build=$(realpath -e -- "${2:?explicit fresh compiler build required}")
test $# == 2 && test ! -e "$output" || { printf 'Refusing arguments/existing output\n' >&2; exit 2; }
test -x "$build/cut-check"
mkdir -p -- "$output"
output=$(realpath -e -- "$output")
for opcode in jmp jo jno jb jae je jne jbe ja js jns jp jnp jl jge jle jg; do
    for prefix in 0 1 2; do
        for padding in 0 192; do
            name=$opcode-$prefix-$padding
            "${CC:-cc}" -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
                -DCUT_BRANCH="$opcode" -DCUT_BRANCH_PREFIX="$prefix" -DCUT_BRANCH_PADDING="$padding" \
                "$repo/src/v2/wasm-compiler/check/cut-fixture.S" -o "$output/$name.linked.elf"
            "$repo/src/v2/postlink-compiler/build/postlink-compiler" \
                "$output/$name.linked.elf" -o "$output/$name.optimized.elf"
            "$repo/src/v2/optimized-x86/build/postlink-verify" \
                "$output/$name.linked.elf" "$output/$name.optimized.elf"
            "$build/cut-check" "$output/$name.optimized.elf" "$output/$name"
        done
    done
done
printf 'Native branch records prepared; not Linux/browser acceptance.\n'
