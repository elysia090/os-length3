#!/bin/sh
# Extract the known Debian repository payloads without running package scripts.
set -eu
[ "$#" -eq 2 ] || { echo "usage: $0 DEB_DIRECTORY NEW_OVERLAY_DIRECTORY" >&2; exit 2; }
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
debs=$(cd "$1" && pwd)
(cd "$debs" && sha256sum -c "$here/debs.sha256")
mkdir "$2"
while read -r digest name; do
  dpkg-deb -x "$debs/$name" "$2"
done < "$here/debs.sha256"
