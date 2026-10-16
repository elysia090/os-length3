#!/bin/sh
# Make l3, the one thing the Prompt depends on: the distribution's root
# (BusyBox from its pinned source and config, its /etc), the l3 command and
# the in-browser translator, with each program's translation made here by
# the same translator so no Prompt spends its first second translating.
# Staged under target/userland, then bundled into public/userland as
# l3-<digest>.bin and l3.json (scripts/bundle.mjs). Build these first:
#   (cd ../../xlat && cargo build --release --target wasm32-unknown-unknown --lib)
#   ../../xlat/userland/build-busybox.sh busybox-1.36.1.tar.bz2
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
xlat=$(cd "$here/../../xlat" && pwd)
out="$here/target/userland"
mkdir -p "$out"
wasm-tools strip "$xlat/target/wasm32-unknown-unknown/release/xlat.wasm" -o "$out/xlat.wasm"
cp "$xlat/userland/out/busybox" "$xlat/userland/out/applets" "$out/"
# l3 in the Prompt is the same command as on the host, built static for xlat.
(cd "$here" && cargo build --profile prompt -p l3 --target x86_64-unknown-linux-musl)
cp "$here/target/x86_64-unknown-linux-musl/prompt/l3" "$out/l3"
# Translated ahead of time; the same output the browser's translator gives.
(cd "$xlat" && cargo build --release --bin xlat)
for p in busybox l3; do "$xlat/target/release/xlat" "$out/$p" "$out/$p.wasm" 2>/dev/null; done
# One file, named by its digest in l3.json; the loose files of before go.
pub="$here/public/userland"
for f in xlat.wasm busybox busybox.wasm l3 l3.wasm applets manifest.json; do rm -f "$pub/$f"; done
node "$here/scripts/bundle.mjs" "$out" "$pub"
