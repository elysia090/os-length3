#!/bin/sh
# The root as layers (a web root: its index, packs and blobs, as a page reads it), made from a release root: the
# translator built from this tree (as wasm, and natively to translate the hot programs ahead of time), then
# build/distribution.ts; and the box's maker put beside it (build/muk-artifact.ts).
#
#   sh ricebox/distribution/build/distribution.sh ROOT.tar.zst OUT
#
# Needs cargo with the wasm32-unknown-unknown target, and a C compiler for muk.
set -eu
[ "$#" -ge 2 ] || { echo "usage: sh ricebox/distribution/build/distribution.sh ROOT.tar.zst OUT" >&2; exit 2; }
build=$(cd "$(dirname "$0")" && pwd)
here=$(cd "$build/../../.." && pwd)
sods=$(cd "$here/ricebox/sods" && pwd)
root=$1
out=$2
shift 2
target=${CARGO_TARGET_DIR:-$sods/target}
(cd "$sods" && cargo build -q --locked --release --target wasm32-unknown-unknown --lib && cargo build -q --locked --release --bin sods)
node "$build/distribution.ts" "$root" "$out" --translator "$target/wasm32-unknown-unknown/release/sods.wasm" --sods "$target/release/sods" "$@"
node "$build/muk-artifact.ts" "$out"

