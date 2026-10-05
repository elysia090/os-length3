#!/usr/bin/env bash
# Real x86 observations for scalar/IP-relative memory binding and ALU forms.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-operand-cuts.sh NEW-OUTPUT-DIRECTORY COMPILER-BUILD}
build=$(realpath -e -- "${2:?explicit fresh compiler build required}")
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
test -x "$build/memory-cut-check"
mkdir -p -- "$output"
for rank in {0..21} {46..87} 181 {210..213} {218..221} 278 279 323 324 396 402; do
  prefix="$output/memory-$rank"
  cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
    -DMEMORY_CASE="$rank" "$repo/src/v2/wasm-compiler/check/memory-fixture.S" -o "$prefix.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
  "$build/memory-cut-check" "$prefix.optimized.elf" "$prefix"
done
