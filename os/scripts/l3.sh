#!/bin/sh
# Make l3 for the browser (public/l3) from a release root: the translator
# built from this tree (as wasm, and natively to translate the hot programs
# ahead of time), then scripts/l3.mjs. The root is the one
# core/src/root.rs pins for the version RELEASE names, fetched by
# scripts/root-file.mjs when it is not given.
#
#   sh scripts/l3.sh [ROOT.tar.zst [OUT]]
#
# Needs cargo with the wasm32-unknown-unknown target.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
xlat=$(cd "$here/../xlat" && pwd)
root=${1:-}
out=${2:-$here/public/l3}
if [ -z "$root" ]; then root=$(node "$here/scripts/root-file.mjs" "$here/target/root"); fi
target=${CARGO_TARGET_DIR:-$xlat/target}
(cd "$xlat" && cargo build -q --release --target wasm32-unknown-unknown --lib && cargo build -q --release --bin xlat)
node "$here/scripts/l3.mjs" "$root" "$out" --translator "$target/wasm32-unknown-unknown/release/xlat.wasm" --xlat "$target/release/xlat" --stage "$here/target/userland"
