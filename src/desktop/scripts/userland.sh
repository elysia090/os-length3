#!/bin/sh
# Copy the in-browser translator and the userland into public/userland so
# the Terminal can start them. Build them first:
#   (cd ../../xlat && cargo build --release --target wasm32-unknown-unknown --lib)
#   ../../xlat/userland/build-busybox.sh busybox-1.36.1.tar.bz2
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
xlat=$(cd "$here/../../xlat" && pwd)
out="$here/public/userland"
mkdir -p "$out"
wasm-tools strip "$xlat/target/wasm32-unknown-unknown/release/xlat.wasm" -o "$out/xlat.wasm"
cp "$xlat/userland/out/busybox" "$xlat/userland/out/applets" "$out/"
ls -la "$out"
