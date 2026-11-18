#!/bin/sh
# The web root this tree's app is built with (why/app/public/webroot): the root why pins newest (why/prompt/roots/pins.rs,
# fetched by why/build/fetch-root.ts when it is not given), made into layers by ricebox itself
# (ricebox/distribution/build/distribution.sh: its index, packs and blobs, and the box's maker beside them).
#
#   sh why/build/webroot.sh [ROOT.tar.zst [OUT]]
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
root=${1:-}
out=${2:-$here/why/app/public/webroot}
if [ -z "$root" ]; then root=$(node "$here/why/build/fetch-root.ts" "$here/target/root"); fi
# Product-specific warm programs and the former CLI name belong here, not in ricebox.
members=$(tar --zstd -tf "$root")
cli=/usr/bin/why
if ! printf '%s\n' "$members" | grep -x 'root/usr/bin/why' >/dev/null; then cli=/usr/bin/l3; fi
sh "$here/ricebox/distribution/build/distribution.sh" "$root" "$out" --name why --hot "/usr/bin/bash,/usr/bin/busybox,$cli,/usr/bin/git"

