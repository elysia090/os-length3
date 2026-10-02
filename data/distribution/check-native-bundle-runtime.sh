#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 || ! -f $1 || ! -f $2 || ! -x $3 || ! -f $4 ]]; then
  printf 'usage: %s BUNDLE.tar.zst RELEASE-INPUTS POSTLINK-VERIFY ZLIB-SOURCE\n' "$0" >&2
  exit 2
fi

here=$(cd -- "$(dirname -- "$0")" && pwd)
bundle=$(realpath -e -- "$1")
inputs=$(realpath -e -- "$2")
verify=$(realpath -e -- "$3")
zlib_source=$(realpath -e -- "$4")
scratch=$(mktemp -d -- "$(dirname -- "$bundle")/.native-bundle-check.XXXXXXXX")
cleanup() {
  if [[ $scratch == "$(dirname -- "$bundle")"/.native-bundle-check.* \
        && -d $scratch ]]; then
    rm -rf -- "$scratch"
  fi
}
trap cleanup EXIT HUP INT TERM

# Test the exact downloadable bytes, not only the pre-archive candidate root.
# This is a build acceptance test; public installation must first authenticate
# the separately published bundle digest or signature.
zstd -q -dc -- "$bundle" | tar -C "$scratch" -xf -
if [[ ! -d $scratch/root || ! -f $scratch/manifest ]]; then
  printf 'native bundle: missing extracted root or manifest\n' >&2
  exit 1
fi
cmp -- "$inputs" "$scratch/manifest"
"$here/check-root.sh" "$scratch/root" "$verify"
bash "$here/check-native-runtime.sh" "$scratch/root"
bash "$here/check-native-development.sh" "$scratch/root" "$zlib_source"
python3 "$here/check-native-https.py" "$scratch/root"
printf 'native bundle runtime: green (extracted root, C, make, Git/HTTPS, packages, upstream build)\n'
