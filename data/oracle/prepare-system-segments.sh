#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-system-segments.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output"
make -C "$repo/src/v2/wasm-compiler" build/system-segments-check
"$repo/src/v2/wasm-compiler/build/system-segments-check" "$output"
as --32 -I "$output" "$repo/data/oracle/system-segments.S" -o "$output/system.o"
ld -m elf_i386 -T "$repo/data/oracle/exception-entry.ld" "$output/system.o" -o "$output/system.elf"
