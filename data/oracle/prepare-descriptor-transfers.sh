#!/usr/bin/env bash
# Ordinary long-mode table transfers; bare executable-page inputs, no ELF proof.
# Run native observations only on an x86 Linux test oracle with UMIP disabled.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-descriptor-transfers.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output/fixtures"
make -C "$repo/src/v2/wasm-compiler" build/table-check build/code-cut-check
"$repo/src/v2/wasm-compiler/build/code-cut-check"
"$repo/src/v2/wasm-compiler/build/table-check" "$output/fixtures"
cc -O2 -std=c11 -Wall -Wextra -Wpedantic -Wconversion -Wshadow \
  "$repo/data/oracle/descriptor-store-observe.c" -o "$output/observe"
"$output/observe" >"$output/native-observation.json"
