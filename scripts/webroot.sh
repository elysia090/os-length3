#!/bin/sh
# Make the web root (public/webroot) from a release root: the translator
# built from this tree (as wasm, and natively to translate the hot programs
# ahead of time), then scripts/webroot.ts. The root is the one
# src/core/src/root/pins.rs pins newest, fetched by
# scripts/root-file.ts when it is not given.
#
#   sh scripts/webroot.sh [ROOT.tar.zst [OUT]]
#
# Needs cargo with the wasm32-unknown-unknown target.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
sods=$(cd "$here/module/sods" && pwd)
root=${1:-}
out=${2:-$here/public/webroot}
if [ -z "$root" ]; then root=$(node "$here/scripts/root-file.ts" "$here/target/root"); fi
target=${CARGO_TARGET_DIR:-$sods/target}
(cd "$sods" && cargo build -q --locked --release --target wasm32-unknown-unknown --lib && cargo build -q --locked --release --bin xlat)
node "$here/scripts/webroot.ts" "$root" "$out" --translator "$target/wasm32-unknown-unknown/release/xlat.wasm" --xlat "$target/release/xlat" --stage "$here/target/userland"
