#!/usr/bin/env bash
# Fresh native observations and emitted bodies for the current entry ABI.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-entry-cuts.sh NEW-OUTPUT-DIRECTORY COMPILER-BUILD}
build=$(realpath -e -- "${2:?explicit fresh compiler build required}")
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
for name in push-memory pop-memory call branch table vector-transfer vector-scalar fxsave fxrstor system-segments; do
    test -x "$build/$name-check"
done
mkdir -p -- "$output"
for name in push-memory pop-memory call branch table vector-transfer vector-scalar fxsave fxrstor system-segments; do
    mkdir -p -- "$output/$name"
    "$build/$name-check" "$output/$name"
done
cc -O2 -std=c11 -Wall -Wextra -Wpedantic -Wconversion -Wshadow \
    "$repo/data/oracle/descriptor-store-observe.c" -o "$output/descriptor-observe"
"$output/descriptor-observe" >"$output/descriptor-observation.json"
