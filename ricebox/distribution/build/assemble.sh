#!/bin/sh
# Assemble the selected package record into one distribution, independent of any product.
# sh ricebox/distribution/build/assemble.sh PACKAGES OUT [VERSION [NAME]]
# Each package has tree/, version, source, key and optionally url. Product composition
# supplies packages too; it may supply os-release and extra provenance in PACKAGES/manifest.
# The same root is used directly or served as layers. No persistence is implied.
set -eu
[ "$#" -ge 2 ] && [ "$#" -le 4 ] || { echo "usage: assemble.sh PACKAGES OUT [VERSION [NAME]]" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
pkgs=$1; out=$2; version=${3:-$(cat "$here/RELEASE")}; name=${4:-ricebox}
case $name in ''|*[!a-zA-Z0-9._-]*) echo 'assemble: invalid distribution name' >&2; exit 2 ;; esac
bad_version() { echo 'assemble: invalid version' >&2; exit 2; }
case $version in *[!a-zA-Z0-9.-]*) bad_version ;; esac
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || bad_version
pkgs=$(cd "$pkgs" && pwd)
say() { echo "root-assemble: $*" >&2; }
[ -s "$pkgs/record" ] || { say "$pkgs has no record: run ricebox/distribution/build/packages.sh first"; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/ricebox-root.XXXXXX")
trap 'rm -rf "${work:?}"' EXIT
mkdir -p "$work/tree/root"
root="$work/tree/root"

# NAME VERSION URL TREE, a line per selected package.
. "$here/pins/sources.env"
while read -r n v _; do
  case $n in ''|*[!a-zA-Z0-9._+-]*) say "invalid package name: $n"; exit 1 ;; esac
  [ -d "$pkgs/$n/tree" ] || { say "$n has no built tree"; exit 1; }
  url=-
  if [ -f "$pkgs/$n/url" ]; then url=$(cat "$pkgs/$n/url")
  elif [ -f "$here/packages/$n/recipe.sh" ]; then
    pin=$(sed -n 's/^pins="\([A-Z0-9_]*\).*/\1/p' "$here/packages/$n/recipe.sh")
    [ -z "$pin" ] || eval "url=\${${pin}_URL}"
  fi
  echo "$n $v $url $pkgs/$n/tree"
done < "$pkgs/record" > "$work/list"

# Each tree, none over another's.
while read -r n _ _ t; do
  (cd "$t" && find . ! -type d | sed "s|^\./|$n |")
done < "$work/list" | sort -k2 > "$work/owners"
twice=$(awk '{print $2}' "$work/owners" | uniq -d)
if [ -n "$twice" ]; then
  for p in $twice; do say "$p is given by $(awk -v p="$p" '$2 == p {print $1}' "$work/owners" | tr '\n' ' ')"; done
  exit 1
fi
while read -r n _ _ t; do cp -a "$t/." "$root/"; done < "$work/list"

# The places every root has.
for d in bin sbin lib; do
  [ ! -e "$root/$d" ] || { say "a package put /$d in the root itself, not under /usr"; exit 1; }
  mkdir -p "$root/usr/$d"; ln -s "usr/$d" "$root/$d"
done
mkdir -p "$root/dev" "$root/proc" "$root/sys" "$root/run" "$root/var/cache" "$root/var/lib" "$root/var/log"
install -d -m 1777 "$root/tmp" "$root/var/tmp"
install -d -m 0700 "$root/root"
ln -s ../run "$root/var/run"

# Its own words: what it is, its shell, and what it is made of.
mkdir -p "$root/etc"
[ -f "$root/etc/os-release" ] || sed "s/@VERSION@/$version/g" "$here/etc/os-release" > "$root/etc/os-release"
chmod 0644 "$root/etc/os-release"
mkdir -p "$root/usr/share/length3"
while read -r n _; do echo "$n $(cat "$pkgs/$n/version") $(cat "$pkgs/$n/source") $(cat "$pkgs/$n/key")"; done < "$pkgs/record" \
  > "$root/usr/share/length3/packages"
install -m 0644 "$here/pins/sources.env" "$root/usr/share/length3/sources.env"
mkdir -p "$root/etc/apk"
printf '%s\n' "# No repository yet: what is installed is all there is (usr/lib/apk/db/installed)." > "$root/etc/apk/repositories"
# The npm package has JavaScript next to its sources. Node does not strip
# TypeScript in node_modules; a source checkout has only the .ts files.
ext=ts
if [ -f "$here/build/script-interpreters.js" ] && [ -f "$here/build/package-database.js" ]; then ext=js; fi
node "$here/build/script-interpreters.$ext" "$root"
node "$here/build/package-database.$ext" "$root" "$work/list"

{
  echo "format=length3-root-v3"
  echo "version=$version"
  sed 's/^\([^ ]*\) \([^ ]*\) \([^ ]*\) \([^ ]*\)$/package.\1=\2 \3 \4/' "$root/usr/share/length3/packages"
  [ ! -f "$pkgs/manifest" ] || cat "$pkgs/manifest"
  echo "assembler.sha256=$(cat "$here/build/assemble.sh" "$here/build/package-database.ts" "$here/build/script-interpreters.ts" "$here/etc/os-release" | sha256sum | cut -d' ' -f1)"
} > "$work/tree/manifest"

name="$name-$version-x86_64"
tar -C "$work/tree" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=pax \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  -cf "$work/$name.tar" manifest root
zstd -q -19 -T1 "$work/$name.tar" -o "$work/$name.tar.zst"
sha=$(sha256sum "$work/$name.tar.zst" | cut -d' ' -f1)
mkdir -p "$out"
mv "$work/$name.tar.zst" "$out/$name-$sha.tar.zst"
size=$(stat -c %s "$out/$name-$sha.tar.zst")
echo "$sha  $name-$sha.tar.zst" > "$out/SHA256SUMS"
cp "$work/tree/manifest" "$out/manifest"
echo "$name-$sha.tar.zst  $size bytes  sha256 $sha"

