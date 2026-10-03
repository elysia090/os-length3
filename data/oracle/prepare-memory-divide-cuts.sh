#!/usr/bin/env bash
# Bare executable pages model boot code; the oracle executes real x86.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-memory-divide-cuts.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" build/memory-divide-check
"$repo/src/v2/wasm-compiler/build/memory-divide-check" "$output"
