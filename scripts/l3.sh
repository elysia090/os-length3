#!/bin/sh
# Make l3 for the browser (public/l3) from a release root: the translator
# built from this tree (as wasm, and natively to translate the hot programs
# ahead of time), then scripts/l3.ts. The root is the one
# core/src/root/pins.rs pins newest, fetched by
# scripts/root-file.ts when it is not given.
#
#   sh scripts/l3.sh [ROOT.tar.zst [OUT]]
#
# Needs cargo with the wasm32-unknown-unknown target.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
sods=$(cd "$here/module/sods" && pwd)
root=${1:-}
out=${2:-$here/public/l3}
if [ -z "$root" ]; then root=$(node "$here/scripts/root-file.ts" "$here/target/root"); fi
target=${CARGO_TARGET_DIR:-$sods/target}
(cd "$sods" && cargo build -q --locked --release --target wasm32-unknown-unknown --lib && cargo build -q --locked --release --bin xlat)
node "$here/scripts/l3.ts" "$root" "$out" --translator "$target/wasm32-unknown-unknown/release/xlat.wasm" --xlat "$target/release/xlat" --stage "$here/target/userland"
