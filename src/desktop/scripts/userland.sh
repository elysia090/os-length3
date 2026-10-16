#!/bin/sh
# Copy the in-browser translator and the userland (BusyBox and l3) into
# public/userland so the Prompt can start them. Build these first:
#   (cd ../../xlat && cargo build --release --target wasm32-unknown-unknown --lib)
#   ../../xlat/userland/build-busybox.sh busybox-1.36.1.tar.bz2
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
xlat=$(cd "$here/../../xlat" && pwd)
out="$here/public/userland"
mkdir -p "$out"
wasm-tools strip "$xlat/target/wasm32-unknown-unknown/release/xlat.wasm" -o "$out/xlat.wasm"
cp "$xlat/userland/out/busybox" "$xlat/userland/out/applets" "$out/"
# l3 in the Prompt is the same command as on the host, built static for xlat.
(cd "$here" && cargo build --profile prompt -p l3 --target x86_64-unknown-linux-musl)
cp "$here/target/x86_64-unknown-linux-musl/prompt/l3" "$out/l3"
# What the Prompt runs, for Runtime to show: names, versions and digests.
. "$here/../../data/sources.env"
sha() { sha256sum "$1" | cut -d' ' -f1; }
cat > "$out/manifest.json" <<JSON
{
  "base": {"name": "BusyBox", "version": "$BUSYBOX_VERSION", "from": "data/sources.env", "sha256": "$(sha "$out/busybox")",
           "applets": $(grep -c . "$out/applets")},
  "tools": [
    {"name": "l3", "version": "$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/cli/Cargo.toml" | head -1)", "sha256": "$(sha "$out/l3")"},
    {"name": "xlat", "version": "$(sed -n 's/^version = "\(.*\)"/\1/p' "$xlat/Cargo.toml" | head -1)", "sha256": "$(sha "$out/xlat.wasm")"}
  ],
  "dotfiles": []
}
JSON
ls -la "$out"
