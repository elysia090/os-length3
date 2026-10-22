#!/bin/sh
# Build the web release of Length³ OS from source: the app's web build with
# l3 for the browser (public/l3: the release root itself, as the browser
# reads it, with the xlat translator; scripts/l3.sh). Nothing is built
# beside the root: its BusyBox, l3 and /etc are the Prompt's. Output: dist/
# and length3-web.zip with its sha256.
#
#   sh scripts/web-release.sh [ROOT.tar.zst]
#
# ROOT is the release root (by default the one core/src/root.rs pins for
# RELEASE, fetched by scripts/root-file.mjs); with L3_READY=1, a public/l3
# made already from it is kept. Needs node 22, cargo with the
# wasm32-unknown-unknown target, and zip.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)

if [ "${L3_READY:-}" = 1 ] && [ -f "$here/public/l3/l3.json" ]; then
  echo "keeping $here/public/l3"
else
  sh "$here/scripts/l3.sh" ${1:+"$1"}
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
