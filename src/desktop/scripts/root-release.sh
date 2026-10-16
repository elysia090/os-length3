#!/bin/sh
# OS Length3 Linux, repackaged: the pinned 0.1.0 root (built by data/build.sh)
# with l3 in it, so the root and the app are one OS in the same words.
#
#   sh scripts/root-release.sh BASE.tar.zst OUT_DIR [VERSION]
#
# Adds /usr/bin/l3 (static, musl, this tree), /etc/os-release,
# /etc/profile and /etc/length3/shrc (the Prompt's shell), and a manifest
# naming the base, l3 and this script. Nothing of the base is changed or
# removed. The tar is deterministic (sorted names, time 0, owner 0) and so
# is its zstd, so the same inputs give the same bundle, byte for byte.
set -eu
base=$1; out=$2; version=${3:-0.2.0}
here=$(cd "$(dirname "$0")/.." && pwd)
BASE_SHA=56229f242fd8860583cb8b17b5f64f21aced1abad99770b306a0432fc260d7b4
echo "$BASE_SHA  $base" | sha256sum -c - >/dev/null || { echo "root-release: $base is not the pinned 0.1.0 bundle" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/length3-root.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir "$work/tree"
tar --zstd -xf "$base" -C "$work/tree"
root="$work/tree/root"

(cd "$here" && cargo build -q --profile prompt -p l3 --target x86_64-unknown-linux-musl)
l3="$here/target/x86_64-unknown-linux-musl/prompt/l3"
install -m 0755 "$l3" "$root/usr/bin/l3"
mkdir -p "$root/etc/length3"
sed "s/@VERSION@/$version/g" "$here/scripts/root/os-release" > "$root/etc/os-release"
install -m 0644 "$here/scripts/root/profile" "$root/etc/profile"
install -m 0644 "$here/scripts/root/shrc" "$root/etc/length3/shrc"
chmod 0644 "$root/etc/os-release"

{
  echo "format=length3-root-repackage-v1"
  echo "version=$version"
  echo "base.version=0.1.0"
  echo "base.sha256=$BASE_SHA"
  echo "l3.sha256=$(sha256sum "$l3" | cut -d' ' -f1)"
  echo "l3.source=$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)$(git -C "$here" status --porcelain -- core cli shared scripts 2>/dev/null | grep -q . && echo +changed)"
  echo "script.sha256=$(cat "$here/scripts/root-release.sh" "$here/scripts/root/"* | sha256sum | cut -d' ' -f1)"
  sed 's/^/base./' "$work/tree/manifest"
} > "$work/manifest.new"
mv "$work/manifest.new" "$work/tree/manifest"

name="os-length3-linux-$version-x86_64"
tar -C "$work/tree" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu \
  -cf "$work/$name.tar" manifest root
zstd -q -19 -T1 "$work/$name.tar" -o "$work/$name.tar.zst"
sha=$(sha256sum "$work/$name.tar.zst" | cut -d' ' -f1)
mkdir -p "$out"
mv "$work/$name.tar.zst" "$out/$name-$sha.tar.zst"
size=$(stat -c %s "$out/$name-$sha.tar.zst")
echo "$sha  $name-$sha.tar.zst" > "$out/SHA256SUMS"
cp "$work/tree/manifest" "$out/manifest"
echo "$name-$sha.tar.zst  $size bytes  sha256 $sha"
