#!/bin/sh
# The root as layers (a web root: its index, packs and blobs, as a page reads it), made from a release root: the
# translator built from this tree (as wasm, and natively to translate the hot programs ahead of time), then
# make/layers.ts; and the box's maker put beside it (make/muk.ts).
#
#   sh module/ricebox/make/layers.sh ROOT.tar.zst OUT
#
# Needs cargo with the wasm32-unknown-unknown target, and a C compiler for muk.
set -eu
[ "$#" -eq 2 ] || { echo "usage: sh module/ricebox/make/layers.sh ROOT.tar.zst OUT" >&2; exit 2; }
make=$(cd "$(dirname "$0")" && pwd)
here=$(cd "$make/../../.." && pwd)
sods=$(cd "$here/module/sods" && pwd)
root=$1
out=$2
target=${CARGO_TARGET_DIR:-$sods/target}
(cd "$sods" && cargo build -q --locked --release --target wasm32-unknown-unknown --lib && cargo build -q --locked --release --bin sods)
node "$make/layers.ts" "$root" "$out" --translator "$target/wasm32-unknown-unknown/release/sods.wasm" --sods "$target/release/sods" --stage "$here/target/userland"
node "$make/muk.ts" "$out"
