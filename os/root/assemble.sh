#!/bin/sh
# OS Length3 Linux's root, put together from its packages (root/build.sh) and this tree's l3, as one bundle.
#
#   sh root/assemble.sh PACKAGES OUT [VERSION]
#
# PACKAGES is what root/build.sh made (each package's tree, key, version and source digest). The root is every
# package's tree, none over another's: a path two packages give stops it, naming both. It is laid out by what each
# place is, the merged /usr of Fedora, Debian and Arch:
#
#   /usr       what the root is: programs, libraries, data (read-only); /bin, /sbin and /lib are links into it
#   /etc       its settings
#   /var/lib   state a package keeps; /var/cache, /var/tmp, /var/log the repo's caches (bound over by the app)
#   /root      home, and each repo at /root/<repo>
#   /tmp, /run the Prompt's own, gone when it ends
#   /dev, /proc, /sys  the kernel's, made by the app
#
# Beside the packages: /usr/bin/l3 (static, musl, this tree's, without the SSH listener: a Prompt listens for no one),
# /etc/os-release (its version), and what the root is made of,
# /usr/share/length3/packages (each package's name, version, source digest and key) with the pins it was made from.
# Its package database says exactly what is there, each file with its checksum (root/db.mjs). The bundle (pax, which
# the installer reads) is deterministic (sorted names, time 0, owner 0, no per-run header names) and so is its zstd:
# the same packages and l3 make the same bundle, byte for byte. OUT gets it, its SHA256SUMS and its manifest.
set -eu
pkgs=$1; out=$2; version=${3:-0.0.0}
here=$(cd "$(dirname "$0")" && pwd)
os=$(cd "$here/.." && pwd)
pkgs=$(cd "$pkgs" && pwd)
say() { echo "root-assemble: $*" >&2; }
[ -s "$pkgs/record" ] || { say "$pkgs has no record: run root/build.sh first"; exit 1; }
for n in $(ls "$here/packages" | sed -n 's/\.sh$//p'); do
  grep -q "^$n " "$pkgs/record" || { say "$n has a recipe and was not made"; exit 1; }
done

work=$(mktemp -d "${TMPDIR:-/tmp}/length3-root.XXXXXX")
trap 'rm -rf "${work:?}"' EXIT
mkdir -p "$work/tree/root" "$work/l3/usr/bin"
root="$work/tree/root"

# l3, as a package of its own.
(cd "$os" && cargo build -q --locked --profile prompt -p l3 --no-default-features --target x86_64-unknown-linux-musl)
l3="$os/target/x86_64-unknown-linux-musl/prompt/l3"
install -m 0755 "$l3" "$work/l3/usr/bin/l3"

# NAME VERSION URL TREE, a line each: the packages, and l3.
. "$here/sources.env"
while read -r n v _; do
  pin=$(sed -n 's/^pins="\([A-Z0-9_]*\).*/\1/p' "$here/packages/$n.sh")
  url=$( [ -n "$pin" ] && eval "echo \"\${${pin}_URL:-}\"" )
  echo "$n $v ${url:--} $pkgs/$n/tree"
done < "$pkgs/record" > "$work/list"
echo "l3 $version https://github.com/elysia090/os-length3 $work/l3" >> "$work/list"

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
sed "s/@VERSION@/$version/g" "$here/os-release" > "$root/etc/os-release"
chmod 0644 "$root/etc/os-release"
mkdir -p "$root/usr/share/length3"
while read -r n _; do echo "$n $(cat "$pkgs/$n/version") $(cat "$pkgs/$n/source") $(cat "$pkgs/$n/key")"; done < "$pkgs/record" \
  > "$root/usr/share/length3/packages"
install -m 0644 "$here/sources.env" "$root/usr/share/length3/sources.env"
mkdir -p "$root/etc/apk"
printf '%s\n' "# No repository yet: what is installed is all there is (usr/lib/apk/db/installed)." > "$root/etc/apk/repositories"
node "$here/db.mjs" "$root" "$work/list"

{
  echo "format=length3-root-v3"
  echo "version=$version"
  sed 's/^\([^ ]*\) \([^ ]*\) \([^ ]*\) \([^ ]*\)$/package.\1=\2 \3 \4/' "$root/usr/share/length3/packages"
  echo "l3.sha256=$(sha256sum "$l3" | cut -d' ' -f1)"
  echo "l3.source=$(git -C "$os" rev-parse HEAD 2>/dev/null || echo unknown)$(git -C "$os" status --porcelain -- core cli shared 2>/dev/null | grep -q . && echo +changed)"
  echo "assembler.sha256=$(cat "$here/assemble.sh" "$here/db.mjs" "$here/os-release" | sha256sum | cut -d' ' -f1)"
} > "$work/tree/manifest"

name="os-length3-linux-$version-x86_64"
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
