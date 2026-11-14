#!/bin/sh
# The web root this tree's app is built with (public/webroot): the root why pins newest (why/core/src/root/pins.rs,
# fetched by scripts/root-file.ts when it is not given), made into layers by ricebox itself
# (module/ricebox/make/layers.sh: its index, packs and blobs, and the box's maker beside them).
#
#   sh scripts/webroot.sh [ROOT.tar.zst [OUT]]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=${1:-}
out=${2:-$here/public/webroot}
if [ -z "$root" ]; then root=$(node "$here/scripts/root-file.ts" "$here/target/root"); fi
sh "$here/module/ricebox/make/layers.sh" "$root" "$out"
