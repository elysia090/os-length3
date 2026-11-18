#!/bin/sh
# Build the web release of why* from source: the app's web build with
# The web root (why/app/public/webroot: the release root itself, as the browser
# reads it, with sods; why/build/webroot.sh). Nothing is built
# beside the root: its BusyBox, why and /etc are the Prompt's. Output: dist/
# and why-web.zip with its sha256.
#
#   sh scripts/web-release.sh [ROOT.tar.zst]
#
# ROOT is the release root (by default the newest why/prompt/roots/pins.rs pins,
# fetched by why/build/fetch-root.ts); with WEBROOT_READY=1, a why/app/public/webroot
# made already from it is kept. Needs node 22, cargo with the
# wasm32-unknown-unknown target, and zip.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)

if [ "${WEBROOT_READY:-}" = 1 ] && [ -f "$here/why/app/public/webroot/webroot.json" ]; then
  echo "keeping $here/why/app/public/webroot"
else
  sh "$here/why/build/webroot.sh" ${1:+"$1"}
fi

cd "$here"
npm ci
npm run check
# The web app talks to the origin it is served from (one Worker: wrangler.toml).
# The check has just run tsc, so only the bundle is made (npm run build would run tsc again).
VITE_LENGTH3_REMOTE="${VITE_LENGTH3_REMOTE-}" npx vite build --config why/app/vite.config.ts
rm -f why-web.zip
(cd dist && zip -qr ../why-web.zip .)
sha256sum why-web.zip | tee why-web.zip.sha256
