#!/bin/sh
# Build the Why web application and bundle the selected guest root.
# Outputs: dist/, why-web.zip and why-web.zip.sha256.
#
#   sh why/build/web-release.sh [ROOT.tar.zst]
#
# ROOT is the release root (by default the newest why/prompt/roots/pins.rs pins,
# fetched by why/build/fetch-root.ts); with WEBROOT_READY=1, a why/app/public/webroot
# already built from it is kept. Requires Node 22, zip, and Rust with the
# wasm32-wasip1 target. Rebuilding the root also needs wasm32-unknown-unknown
# and a C compiler for Muk.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)

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
