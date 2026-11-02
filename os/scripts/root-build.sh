#!/bin/sh
# OS Length3 Linux's root, package by package: each made from the source this tree pins (distribution/sources.env)
# by its recipe (scripts/root-packages/NAME.sh), on one machine, Alpine 3.24 at the digest CI names
# (x86_64-alpine-linux-musl, the root's target), with one libc (Alpine's musl, at the version the root's own musl is
# made from, with the same security fixes), static, hardened, stripped, and nothing done to it after the linker.
#
#   sh scripts/root-build.sh OUT [NAME...]
#
# Each package is made only when what it is made of changed. Its key is the digest of its recipe, the pins it
# names, its patches and other inputs, this script, the compiler, linker and libc it is built with, and the keys of
# the packages it builds against: OUT/NAME holds what its install put there (tree/), its key, version and source
# digest, and is made again only when its key is not the one there. NAMEs given are made (with what they need);
# none, every one. Run as root (CI runs it in its container); OWNER (uid:gid) given, OUT is that user's when it ends,
# however it ends. Sources are kept in OUT/../root-src by name, each checked against its pin before it is opened.
#
# A recipe is sh, read in a shell of its own, saying:
#   pins="NAME..."      the sources.env prefixes it is made from (NAME_VERSION, NAME_URL, NAME_SHA256 or _SHA512);
#                       the first unpacked where it is built, the others by `unpack NAME DIR`
#   needs="PKG..."      packages it builds against: their trees, together, are $deps, which CPPFLAGS, LDFLAGS and
#                       pkg-config point to (and nothing of the build machine's own besides its libc and kernel headers)
#   tools="APK..."      Alpine packages it is built with
#   patches="FILE..."   under scripts/root-packages/, applied in order (-p1)
#   inputs="FILE..."    files of this tree it is made from (from the repository's top), in its key too
#   flat=1              its first pin's archive has no top directory to take off (tzdata's)
#   version=V           its version, where it has no pin to take it from (the root's own settings)
#   build() { ... }     run in the unpacked source; installs into $dest as the root lays it out (/usr, /etc)
#   check() { ... }     optional: run after it is made, against what is in $dest; a package that does not do what it
#                       is for is not made
#
# Every build is given the same flags (a recipe that departs from them says why): C17 (Alpine's GCC writes C23 by
# default, which code written for C17 does not build as), the stack protector, stack clash protection and CET, and
# static links with full RELRO and no executable stack; Alpine's GCC makes position-independent code and links
# -static as a static PIE, and defines _FORTIFY_SOURCE. A library comes with what building against it needs (its
# headers, archive and pkg-config file), not its libtool archive; no package keeps manuals, translations or another
# shell's completions (the root has no man, no locales and no bash).
set -eu
out=$1; shift
here=$(cd "$(dirname "$0")/.." && pwd)
recipes="$here/scripts/root-packages"
top=$(cd "$here/.." && pwd)
pin_files="$top/distribution/sources.env $top/distribution/bootstrap/tzcode.env"
for f in $pin_files; do . "$f"; done
say() { echo "root-build: $*" >&2; }
grep -q '^3\.24\.' /etc/alpine-release 2>/dev/null || { say "run on Alpine 3.24 (the root's target)"; exit 2; }

# What every recipe is built with, and each one's own tools.
apk add --no-cache -q build-base linux-headers curl xz bzip2 tar patch \
  $(sed -n 's/^tools="\(.*\)"$/\1/p' "$recipes"/*.sh | tr ' ' '\n' | sort -u)
target=$(gcc -dumpmachine)
[ "$target" = x86_64-alpine-linux-musl ] || { say "this compiler targets $target, not x86_64-alpine-linux-musl"; exit 2; }
# An installed Alpine package's version, as its database says it.
installed() { awk -v p="$1" '/^P:/ {n = substr($0, 3)} /^V:/ && n == p {print substr($0, 3)}' /lib/apk/db/installed; }
# The one libc: Alpine's musl, at the version the root's own is made from.
libc=$(installed musl-dev)
case $libc in "$MUSL_VERSION"-r*) ;; *) say "Alpine's musl is ${libc:-not installed}, the root's $MUSL_VERSION: pin them alike"; exit 2 ;; esac
# What a build's output follows from beyond its recipe: this script, and the compiler, linker, libc and kernel headers.
machine=$({ cat "$0"; for p in gcc binutils musl-dev linux-headers make fortify-headers; do echo "$p $(installed "$p")"; done; } |
  sha256sum | cut -d' ' -f1)

mkdir -p "$out"
out=$(cd "$out" && pwd)
src="$out/../root-src"
mkdir -p "$src"
work=$(mktemp -d "${TMPDIR:-/tmp}/length3-root-build.XXXXXX")
trap 'rm -rf "${work:?}"; if [ -n "${OWNER:-}" ]; then chown "$OWNER" "$out/.."; chown -R "$OWNER" "$out" "$src"; fi' EXIT
jobs=$(nproc)
# What a build may stamp into what it makes (a date, a build time) is the epoch, so the same inputs make the same bytes.
export SOURCE_DATE_EPOCH=0

fields='pins= needs= tools= patches= inputs= flat= version='
field() { (eval "$fields"; . "$recipes/$1.sh"; eval "echo \"\$$2\""); }
all=$(cd "$recipes" && ls *.sh | sed 's/\.sh$//')

# NAME: the pins' lines it is made of, as the pin files say them.
pinned() { for p in $(field "$1" pins); do cat $pin_files | grep "^${p}_" || { say "$1: no pin $p"; exit 1; }; done; }
key_of() {
  { echo "$machine"; cat "$recipes/$1.sh"; pinned "$1"
    for p in $(field "$1" patches); do echo "$p"; cat "$recipes/$p"; done
    for f in $(field "$1" inputs); do echo "$f"; cat "$top/$f"; done
    for n in $(field "$1" needs); do echo "$n $(cat "$out/$n/key")"; done
  } | sha256sum | cut -d' ' -f1
}

# PIN DIR [flat]: the pinned source, checked against its digest, unpacked into DIR (its top directory taken off,
# unless flat; a file that is no archive, as the CA bundle, put there as it is).
unpack() {
  url=$(eval "echo \"\${$1_URL}\""); sum=$(eval "echo \"\${$1_SHA256:-}\""); alg=sha256
  [ -n "$sum" ] || { sum=$(eval "echo \"\${$1_SHA512}\""); alg=sha512; }
  f="$src/$(basename "$url")"
  if ! echo "$sum  $f" | ${alg}sum -c - >/dev/null 2>&1; then
    curl -fsSL --retry 4 -o "$f.part" "$url"
    echo "$sum  $f.part" | ${alg}sum -c - >/dev/null || { say "$url is not the file pinned"; exit 1; }
    mv "$f.part" "$f"
  fi
  mkdir -p "$2"
  case $f in
    *.tar.*|*.tgz) if [ "${3:-}" = flat ]; then tar -xf "$f" -C "$2"; else tar -xf "$f" -C "$2" --strip-components=1; fi ;;
    *) cp "$f" "$2/" ;;
  esac
}
is_elf() { [ "$(head -c 4 "$1" | od -An -c | tr -d ' ')" = "177ELF" ]; }

# NAME KEY, made: its source unpacked, its patches applied, its build run against what it needs, then laid out,
# what no root keeps taken out, stripped, every program checked to stand alone, and its own check run.
make_one() {
  name=$1; key=$2
  w="$work/$name"; t="$out/$name/tree"
  rm -rf "${w:?}" "${out:?}/${name:?}"; mkdir -p "$w/deps" "$w/src" "$t"
  first=$(field "$name" pins | cut -d' ' -f1)
  [ -z "$first" ] || unpack "$first" "$w/src" "$([ -n "$(field "$name" flat)" ] && echo flat)"
  for n in $(field "$name" needs); do cp -a "$out/$n/tree/." "$w/deps/"; done
  for p in $(field "$name" patches); do patch -d "$w/src" -p1 -s < "$recipes/$p"; done
  say "$name: making"
  (
    cd "$w/src"
    dest=$t; deps="$w/deps"
    ld='-Wl,-z,relro,-z,now,-z,noexecstack'
    export CC=gcc CXX=g++ AR=ar RANLIB=ranlib \
      CFLAGS='-O2 -std=gnu17 -fstack-protector-strong -fstack-clash-protection -fcf-protection' \
      CXXFLAGS='-O2 -fstack-protector-strong -fstack-clash-protection -fcf-protection' \
      CPPFLAGS="-I$deps/usr/include" LDFLAGS="-static $ld -L$deps/usr/lib" \
      PKG_CONFIG=pkg-config PKG_CONFIG_LIBDIR="$deps/usr/lib/pkgconfig" PKG_CONFIG_SYSROOT_DIR="$deps"
    # libtool takes -static as "prefer static libraries" and links a dynamic program: at make time it is told
    # -all-static, which it passes on.
    allstatic="-all-static $ld -L$deps/usr/lib"
    eval "$fields"
    . "$recipes/$name.sh"
    build
  ) > "$w/log" 2>&1 || { tail -n 100 "$w/log" >&2; say "$name: its build failed (the end of its log is above)"; exit 1; }
  # Laid out as the root is: /bin, /sbin and /lib are /usr's.
  for d in bin sbin lib; do
    [ -d "$t/$d" ] && [ ! -L "$t/$d" ] || continue
    mkdir -p "$t/usr/$d"; cp -a "$t/$d/." "$t/usr/$d/"; rm -rf "${t:?}/${d:?}"
  done
  for d in usr/share/man usr/man usr/share/doc usr/share/info usr/share/locale usr/share/gtk-doc usr/share/bash-completion; do
    rm -rf "${t:?}/$d"
  done
  find "$t" -name '*.la' -type f -delete
  # Stripped in place (a hard link stays one): a program's symbols and debug sections out; an archive or object
  # keeps its symbols (a link needs them) and loses its debug sections.
  find "$t" -type f | while read -r f; do
    case $f in *.a|*.o) mode=--strip-debug ;; *) is_elf "$f" || continue; mode=--strip-all ;; esac
    strip "$mode" -o "$w/stripped" "$f" && cat "$w/stripped" > "$f"
  done
  rm -f "${w:?}/stripped"
  bad=$(find "$t" -type f -perm -u+x | while read -r f; do
    is_elf "$f" || continue
    interp=$(readelf -l "$f" 2>/dev/null | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
    [ -z "$interp" ] || echo "${f#"$t/"} (interpreter $interp)"
  done)
  [ -z "$bad" ] || { say "$name: not static: $bad"; exit 1; }
  # What it is for, done by what was made.
  (
    cd "$w"; dest=$t
    eval "$fields"; check() { :; }
    . "$recipes/$name.sh"
    check
  ) > "$w/check" 2>&1 || { cat "$w/check" >&2; say "$name: made, but its check failed (above)"; exit 1; }
  v=$(field "$name" version)
  [ -n "$v" ] || [ -z "$first" ] || v=$(eval "echo \"\${${first}_VERSION:-\${${first}_DATE:-}}\"")
  echo "${v:-0}" > "$out/$name/version"
  if [ -n "$first" ]; then
    url=$(eval "echo \"\${${first}_URL}\""); sha256sum "$src/$(basename "$url")" | cut -d' ' -f1 > "$out/$name/source"
  else : > "$out/$name/source"; fi
  echo "$key" > "$out/$name/key"
  say "$name $(cat "$out/$name/version"): made"
}

# Each NAME after what it needs, made only when its key is not the one kept.
done_=" "; visiting=" "
visit() {
  case $done_ in *" $1 "*) return ;; esac
  case $visiting in *" $1 "*) say "$1 needs itself"; exit 1 ;; esac
  visiting="$visiting$1 "
  [ -f "$recipes/$1.sh" ] || { say "no recipe for $1"; exit 1; }
  for n in $(field "$1" needs); do visit "$n"; done
  k=$(key_of "$1")
  if [ "$(cat "$out/$1/key" 2>/dev/null)" = "$k" ]; then say "$1: kept"; else make_one "$1" "$k"; fi
  done_="$done_$1 "
}
for n in ${*:-$all}; do visit "$n"; done
# What was made: name, version, its source's sha256, a line each.
for n in $all; do
  if [ -f "$out/$n/key" ]; then echo "$n $(cat "$out/$n/version") $(cat "$out/$n/source")"; fi
done > "$out/record"
