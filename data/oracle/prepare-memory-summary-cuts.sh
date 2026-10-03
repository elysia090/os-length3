#!/usr/bin/env bash
# Native x86 receipts after ordinary link -> post-link -> proof verification.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-memory-summary-cuts.sh NEW-OUTPUT-DIRECTORY [--built]}
test "$#" -le 2 && [[ ${2-} == '' || ${2-} == --built ]] || exit 2
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
# In the parent Make graph, fixture-tools has already completed. Rebuilding
# its executable while another fixture calls it would race the linker.
if [[ ${2-} != --built ]]; then
    make -C "$repo/src/v2/wasm-compiler" all build/memory-cut-check fixture-tools
fi
rank=459
for kind in {0..4}; do for width in 16 32 64; do for form in {0..8}; do
    prefix="$output/memory-$rank"
    cc -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
      -DSUMMARY_KIND="$kind" -DMEMORY_WIDTH="$width" -DMEMORY_SUMMARY_CASE="$form" \
      "$repo/src/v2/wasm-compiler/check/memory-summary-fixture.S" -o "$prefix.linked.elf"
    "$repo/src/v2/postlink-compiler/build/postlink-compiler" "$prefix.linked.elf" -o "$prefix.optimized.elf"
    "$repo/src/v2/optimized-x86/build/postlink-verify" "$prefix.linked.elf" "$prefix.optimized.elf"
    "$repo/src/v2/wasm-compiler/build/memory-cut-check" "$prefix.optimized.elf" "$prefix"
    rank=$((rank+1))
done; done; done
test "$rank" = 594
