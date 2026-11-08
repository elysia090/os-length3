#!/bin/sh
# Build the web release of Length³ OS from source: the app's web build with
# The web root (public/webroot: the release root itself, as the browser
# reads it, with the xlat translator; scripts/webroot.sh). Nothing is built
# beside the root: its BusyBox, root3 and /etc are the Prompt's. Output: dist/
# and length3-web.zip with its sha256.
#
#   sh scripts/web-release.sh [ROOT.tar.zst]
#
# ROOT is the release root (by default the newest src/core/src/root/pins.rs pins,
# fetched by scripts/root-file.ts); with WEBROOT_READY=1, a public/webroot
# made already from it is kept. Needs node 22, cargo with the
# wasm32-unknown-unknown target, and zip.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)

if [ "${WEBROOT_READY:-}" = 1 ] && [ -f "$here/public/webroot/webroot.json" ]; then
  echo "keeping $here/public/webroot"
else
  sh "$here/scripts/webroot.sh" ${1:+"$1"}
fi

cd "$here"
npm ci
npm run check
# The web app talks to the origin it is served from (one Worker: wrangler.toml).
# The check has just run tsc, so only the bundle is made (npm run build would run tsc again).
VITE_LENGTH3_REMOTE="${VITE_LENGTH3_REMOTE-}" npx vite build
rm -f length3-web.zip
(cd dist && zip -qr ../length3-web.zip .)
sha256sum length3-web.zip | tee length3-web.zip.sha256
