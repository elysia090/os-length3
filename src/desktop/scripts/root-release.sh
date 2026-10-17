#!/bin/sh
# OS Length3 Linux, repackaged: the pinned 0.1.0 root (built by data/build.sh)
# with l3 in it, so the root and the app are one OS in the same words.
#
#   sh scripts/root-release.sh BASE.tar.zst OUT_DIR [VERSION]
#
# The base was made to boot as a machine of its own; a Prompt is not one.
# So what only booting needed goes (the kernel and initramfs, /init and its
# s6 services, dhcpcd, chrony, mdevd, kmod, e2fsprogs, nftables, the build's
# own test Makefile, the 0.1.0 repository index no package can be fetched
# from), the root takes the merged /usr layout (/bin, /sbin and /lib are
# links into /usr, as on Fedora, Debian, Arch), its records are named for
# this OS (/usr/share/length3), and the package database is rewritten to
# say exactly what is there. What a root is, by where it is:
#
#   /usr       what the root is: programs, libraries, data (read-only)
#   /etc       its settings
#   /var/lib   state a package keeps; /var/cache, /var/tmp, /var/log the
#              repo's caches (bound over by the app)
#   /root      home, and each repo at /root/<repo>
#   /tmp, /run the Prompt's own, gone when it ends
#   /dev, /proc, /sys  the kernel's, made by the app
#
# Then adds /usr/bin/l3 (static, musl, this tree), /etc/os-release,
# /etc/profile and /etc/length3/shrc (the Prompt's shell), and a manifest
# naming the base, l3 and this script. The tar (pax, which the installer
# reads) is deterministic (sorted names, time 0, owner 0, no per-run header
# names) and so is its zstd, so the same inputs give the same bundle, byte
# for byte.
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
db="$root/lib/apk/db/installed"

# Packages only a booted machine needs, and files of kept packages that are
# the same (or that another package gives in full: busybox's mount beside
# util-linux's).
DROP="linux-boot base-services mdevd s6-rc s6 execline skalibs chrony dhcpcd kmod e2fsprogs nftables"
GONE="busybox:init busybox:opt/qm/Makefile system-config:etc/mdev.conf system-config:etc/nftables.conf shadow:usr/sbin/logoutd"
for n in switch_root insmod lsmod modprobe rmmod blkid fdisk ip; do GONE="$GONE busybox:sbin/$n"; done
for n in dmesg mount umount; do GONE="$GONE busybox:bin/$n"; done

# Every file the db gives a package, as package:path.
owned() { awk '/^P:/{p=substr($0,3); d=""} /^F:/{d=substr($0,3)} /^R:/{print p":"(d==""?"":d"/")substr($0,3)}' "$db"; }
owned | while IFS=: read -r p f; do
  case " $DROP " in *" $p "*) rm -f "$root/$f" ;; *) case " $GONE " in *" $p:$f "*) rm -f "$root/$f" ;; esac ;; esac
done
# Their directories, deepest first, where nothing else is left in them.
awk -v drop=" $DROP " '/^P:/{p=substr($0,3)} /^F:./{if (index(drop, " "p" ")) print substr($0,3)}' "$db" | sort -ru |
  while read -r d; do rmdir "$root/$d" 2>/dev/null || true; done
for d in opt/qm opt boot; do rmdir "$root/$d" 2>/dev/null || true; done
rm -f "$root/system/apk/Packages.adb"; rmdir "$root/system/apk" "$root/system"
mv "$root/usr/share/qm" "$root/usr/share/length3"

# Merged /usr.
for d in bin sbin lib; do
  mkdir -p "$root/usr/$d"
  for f in "$root/$d"/*; do mv "$f" "$root/usr/$d/"; done
  rmdir "$root/$d"; ln -s "usr/$d" "$root/$d"
done
# The places every root has, whatever packages made or left them.
mkdir -p "$root/dev" "$root/proc" "$root/sys" "$root/run" "$root/var/cache" "$root/var/lib" "$root/var/log"
install -d -m 1777 "$root/tmp" "$root/var/tmp"
install -d -m 0700 "$root/root"
[ -L "$root/var/run" ] || ln -s ../run "$root/var/run"

# The db, as the tree now is: paths moved, dropped packages and files out,
# directories that are gone no longer owned, and no package needing one dropped.
dirs="$work/dirs"
(cd "$root" && find . \( -type d -o -type l \) -print | sed 's|^\./||; s|^\.$||') > "$dirs"
awk -v drop=" $DROP " -v gone=" $GONE " '
  FNR == NR { have[$0] = 1; next }
  function moved(d) {
    if (d ~ /^(bin|sbin|lib)(\/|$)/) return "usr/" d
    if (d ~ /^usr\/share\/qm(\/|$)/) sub(/^usr\/share\/qm/, "usr/share/length3", d)
    return d
  }
  function flush(   i, l, p, keep, file, skip, d, n, deps, k, out) {
    p = ""; if (!first) first = nb + 1
    for (i = 1; i <= nb; i++) if (b[i] ~ /^P:/) p = substr(b[i], 3)
    if (p != "" && !index(drop, " " p " ")) {
      for (i = 1; i <= nb; i++) {
        l = b[i]
        if (l ~ /^F:/) { d = substr(l, 3); keep = (moved(d) in have); file = 0; if (keep) print "F:" moved(d) }
        else if (l ~ /^R:/) { file = 1; skip = !keep || index(gone, " " p ":" (d == "" ? "" : d "/") substr(l, 3) " "); if (!skip) print l }
        else if (i < first && l !~ /^D:/) print l
        else if (l ~ /^[aMZ]:/) { if (file ? !skip : keep) print l }
        else if (l ~ /^D:/) {
          n = split(substr(l, 3), deps, " "); out = ""
          for (k = 1; k <= n; k++) if (!index(drop, " " deps[k] " ")) out = out (out == "" ? "" : " ") deps[k]
          if (out != "") print "D:" out
        }
      }
      print ""
    }
    nb = 0; first = 0
  }
  /^$/ { flush(); next }
  { b[++nb] = $0; if (!first && /^F:/) first = nb }
  END { if (nb) flush() }
' "$dirs" "$db" > "$db.new"
rm -f "$dirs"
mv "$db.new" "$db"
grep -v -E "^($(echo $DROP | tr ' ' '|'))=" "$root/etc/apk/world" > "$root/etc/apk/world.new"
mv "$root/etc/apk/world.new" "$root/etc/apk/world"
chmod 0644 "$db" "$root/etc/apk/world"
printf '%s\n' "# No repository yet: what is installed is all there is (lib/apk/db/installed)." > "$root/etc/apk/repositories"
# Every file the db names is there.
owned | while IFS=: read -r p f; do
  [ -e "$root/$f" ] || [ -L "$root/$f" ] || { echo "root-release: $p owns $f, which is not there" >&2; exit 1; }
done

(cd "$here" && cargo build -q --profile prompt -p l3 --target x86_64-unknown-linux-musl)
l3="$here/target/x86_64-unknown-linux-musl/prompt/l3"
install -m 0755 "$l3" "$root/usr/bin/l3"
mkdir -p "$root/etc/length3"
sed "s/@VERSION@/$version/g" "$here/scripts/root/os-release" > "$root/etc/os-release"
install -m 0644 "$here/scripts/root/profile" "$root/etc/profile"
install -m 0644 "$here/scripts/root/shrc" "$root/etc/length3/shrc"
chmod 0644 "$root/etc/os-release"

{
  echo "format=length3-root-repackage-v2"
  echo "dropped=$DROP"
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
