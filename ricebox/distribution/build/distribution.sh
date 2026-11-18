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
case "$target" in /*) ;; *) target="$PWD/$target" ;; esac
if [ -n "${CARGO_TARGET_DIR:-}" ]; then export CARGO_TARGET_DIR="$target"; fi
(cd "$sods" && cargo build -q --locked --release --target wasm32-unknown-unknown --lib && cargo build -q --locked --release --bin sods)

# Compose both pieces privately. The publisher keeps recoverable old files in
# a sibling directory, outside the disposable workspace and published tree.
parent=${RICEBOX_STAGE_PARENT:-$(dirname "$out")}
mkdir -p "$parent"
work=$(mktemp -d "$parent/.ricebox-webroot.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$build/distribution.ts" "$root" "$work/next" --translator "$target/wasm32-unknown-unknown/release/sods.wasm" --sods "$target/release/sods" "$@"
node "$build/muk-artifact.ts" "$work/next"
node "$build/publish-tree.ts" "$work/next" "$out" "$parent"
printf 'Web root is in %s\n' "$out"
