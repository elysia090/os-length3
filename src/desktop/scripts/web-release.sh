#!/bin/sh
# Build the web release of Length³ OS from source: the app's web build with
# the Prompt's userland (BusyBox from its pinned, checked source; l3; the
# xlat translator as wasm). Output: dist/ and length3-web.zip with its sha256.
#
#   sh scripts/web-release.sh
#
# Needs node 22, cargo with the wasm32-unknown-unknown and
# x86_64-unknown-linux-musl targets, musl-gcc, curl and zip.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
. "$repo/data/sources.env"

# BusyBox from its pinned source (build-busybox.sh checks the sha256). A
# tarball can be given in $BUSYBOX_TARBALL; with REUSE_BUSYBOX=1 an existing
# xlat/userland/out/busybox is kept (for hosts that cannot reach busybox.net).
if [ "${REUSE_BUSYBOX:-}" = 1 ] && [ -x "$repo/xlat/userland/out/busybox" ]; then
  echo "keeping $repo/xlat/userland/out/busybox"
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  tarball=${BUSYBOX_TARBALL:-$work/busybox-$BUSYBOX_VERSION.tar.bz2}
  [ -f "$tarball" ] || curl -fsSL "$BUSYBOX_URL" -o "$tarball"
  sh "$repo/xlat/userland/build-busybox.sh" "$tarball"
fi

(cd "$repo/xlat" && cargo build --release --target wasm32-unknown-unknown --lib)
command -v wasm-tools >/dev/null || cargo install --locked wasm-tools@1.262.0
sh "$here/scripts/userland.sh"

cd "$here"
npm ci
npm run check
# The web app talks to the origin it is served from (one Worker: service/wrangler.toml).
VITE_LENGTH3_REMOTE="${VITE_LENGTH3_REMOTE-}" npm run build
rm -f length3-web.zip
(cd dist && zip -qr ../length3-web.zip .)
sha256sum length3-web.zip | tee length3-web.zip.sha256
