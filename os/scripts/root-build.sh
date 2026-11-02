#!/bin/sh
# OS Length3 Linux's root, package by package: each made from the source this tree pins (distribution/sources.env)
# by its recipe (scripts/root-packages/NAME.sh), static, stripped, and nothing done to it after the linker; on one
# machine, Alpine 3.24 at the digest CI names (x86_64-alpine-linux-musl, the root's target), whose musl every
# program here is linked with and whose version the root's own musl is.
#
#   sh scripts/root-build.sh OUT [NAME...]
#
# Each package is made only when what it is made of changed. Its key is the digest of its recipe, the pins it
# names, its patches, this script, the compiler and libc it is built with, and the keys of the packages it builds
# against (`needs`): OUT/NAME holds what its install put there (tree/), its key, version and source digest, and is
# made again only when its key is not the one there. NAMEs given are made (with what they need); none, every one.
# Run as root (CI runs it in its container); OWNER (uid:gid) given, OUT is that user's when it ends, however it ends.
#
# A recipe is sh, read in a shell of its own, saying:
#   pins="NAME..."      the sources.env prefixes it is made from (NAME_VERSION, NAME_URL, NAME_SHA256 or _SHA512),
#                       the first unpacked where it is built, the others by `unpack NAME DIR`
#   needs="PKG..."      packages it builds against: their trees, together, are $deps (CPPFLAGS, LDFLAGS and pkg-config
#                       point there)
#   tools="APK..."      Alpine packages it is built with
#   patches="FILE..."   under scripts/root-packages/, applied in order (-p1)
#   inputs="FILE..."    files of this tree it is made from (from the repository's top), in its key too
#   flat=1              its first pin's archive has no top directory to take off (tzdata's)
#   version=V           its version, where it has no pin to take it from (the root's own settings)
#   build() { ... }     run in the unpacked source; installs into $dest, laid out as the root is (/usr)
set -eu
out=$1; shift
here=$(cd "$(dirname "$0")/.." && pwd)
recipes="$here/scripts/root-packages"
top=$(cd "$here/.." && pwd)
pin_files="$top/distribution/sources.env $top/distribution/bootstrap/tzcode.env"
for f in $pin_files; do . "$f"; done
say() { echo "root-build: $*" >&2; }
grep -q '^3\.24\.' /etc/alpine-release 2>/dev/null || { say "run on Alpine 3.24 (the root's target)"; exit 2; }

# What every recipe is built with, and its own tools.
apk add --no-cache -q build-base linux-headers curl xz bzip2 tar \
  $(sed -n 's/^tools="\(.*\)"$/\1/p' "$recipes"/*.sh | tr ' ' '\n' | sort -u)
target=$(gcc -dumpmachine)
[ "$target" = x86_64-alpine-linux-musl ] || { say "this compiler targets $target, not x86_64-alpine-linux-musl"; exit 2; }
# The one libc: Alpine's musl, at the version the root's own is made from (its patches are Alpine's security fixes).
libc=$(apk info -v musl-dev 2>/dev/null | sed -n 's/^musl-dev-//p')
case $libc in "$MUSL_VERSION"-r*) ;; *) say "Alpine's musl is $libc, the root's is $MUSL_VERSION: pin them alike"; exit 2 ;; esac
# What a build's output follows from beyond its recipe: this script, the compiler, the linker and the libc.
machine=$(printf '%s\n' "$(cat "$0")" "$(apk info -v gcc binutils musl-dev make 2>/dev/null | sort)" | sha256sum | cut -d' ' -f1)

mkdir -p "$out"
out=$(cd "$out" && pwd)
src="$out/../root-src"
mkdir -p "$src"
work=$(mktemp -d "${TMPDIR:-/tmp}/length3-root-build.XXXXXX")
trap 'rm -rf "$work"; if [ -n "${OWNER:-}" ]; then chown "$OWNER" "$out/.."; chown -R "$OWNER" "$out" "$src"; fi' EXIT
jobs=$(nproc)

field() { (pins=; needs=; tools=; patches=; inputs=; flat=; version=; . "$recipes/$1.sh"; eval "echo \"\$$2\""); }
all=$(cd "$recipes" && ls *.sh | sed 's/\.sh$//')

# NAME: the pins' lines it is made of, as sources.env says them.
pinned() { for p in $(field "$1" pins); do cat $pin_files | grep "^${p}_" || { say "$1: no pin $p"; exit 1; }; done; }
key_of() {
  { echo "$machine"; cat "$recipes/$1.sh"; pinned "$1"
    for p in $(field "$1" patches); do cat "$recipes/$p"; done
    for f in $(field "$1" inputs); do echo "$f"; cat "$top/$f"; done
    for n in $(field "$1" needs); do cat "$out/$n/key"; done
  } | sha256sum | cut -d' ' -f1
}

# PIN DIR [flat]: the pinned source, checked against its digest, unpacked into DIR (its top directory taken off,
# unless flat).
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

# NAME, made: its source unpacked, its patches applied, its build run against what it needs, then laid out, its
# manuals out, stripped, and every program checked to stand alone.
make_one() {
  name=$1; key=$2
  w="$work/$name"; rm -rf "$w" "$out/$name"; mkdir -p "$w/deps" "$out/$name/tree"
  first=$(field "$name" pins | cut -d' ' -f1)
  [ -z "$first" ] || unpack "$first" "$w/src" "$([ -n "$(field "$name" flat)" ] && echo flat)"
  mkdir -p "$w/src"
  for n in $(field "$name" needs); do cp -a "$out/$n/tree/." "$w/deps/"; done
  for p in $(field "$name" patches); do patch -d "$w/src" -p1 -s < "$recipes/$p"; done
  say "$name: making"
  (
    cd "$w/src"
    dest="$out/$name/tree"; deps="$w/deps"
    # The flags the root's programs are built with: C17 (Alpine's GCC writes C23 by default, which code written for
    # C17 does not build as), and, where a recipe asks, the standard hardening and a static PIE.
    c17='-O2 -std=gnu17'
    hard='-O2 -fstack-protector-strong -fstack-clash-protection -fcf-protection'
    pie='-static-pie -Wl,-z,relro,-z,now,-z,noexecstack'
    export CPPFLAGS="-I$deps/usr/include" LDFLAGS="-L$deps/usr/lib" \
      PKG_CONFIG_LIBDIR="$deps/usr/lib/pkgconfig" PKG_CONFIG_SYSROOT_DIR="$deps"
    pins=; needs=; tools=; patches=; inputs=; flat=; version=
    . "$recipes/$name.sh"
    build
  ) > "$w/log" 2>&1 || { tail -n 80 "$w/log" >&2; say "$name: its build failed (the end of its log is above)"; exit 1; }
  t="$out/$name/tree"
  # Laid out as the root is: /bin, /sbin and /lib are /usr's.
  for d in bin sbin lib; do
    [ -d "$t/$d" ] && [ ! -L "$t/$d" ] || continue
    mkdir -p "$t/usr/$d"; cp -a "$t/$d/." "$t/usr/$d/"; rm -rf "$t/$d"
  done
  rm -rf "$t/usr/share/man" "$t/usr/man" "$t/usr/share/doc" "$t/usr/share/info" "$t/usr/share/gtk-doc"
  # Stripped: each program's debug sections and symbols out; archives and objects keep their symbols (a link
  # needs them) and lose their debug sections.
  find "$t" -type f | while read -r f; do
    [ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = "177ELF" ] || case $f in *.a) ;; *) continue ;; esac
    case $f in *.a|*.o) strip --strip-debug "$f" ;; *) strip --strip-all "$f" ;; esac
  done
  bad=$(find "$t" -type f -perm -u+x | while read -r f; do
    [ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = "177ELF" ] || continue
    interp=$(readelf -l "$f" 2>/dev/null | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
    [ -z "$interp" ] || echo "${f#"$t/"} (interpreter $interp)"
  done)
  [ -z "$bad" ] || { say "$name: not static: $bad"; exit 1; }
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
done_=" "
visit() {
  case $done_ in *" $1 "*) return ;; esac
  case ${visiting:-} in *" $1 "*) say "$1 needs itself"; exit 1 ;; esac
  visiting="${visiting:-} $1 "
  [ -f "$recipes/$1.sh" ] || { say "no recipe for $1"; exit 1; }
  for n in $(field "$1" needs); do visit "$n"; done
  k=$(key_of "$1")
  if [ "$(cat "$out/$1/key" 2>/dev/null)" = "$k" ]; then say "$1: kept"; else make_one "$1" "$k"; fi
  done_="$done_$1 "
}
for n in ${*:-$all}; do visit "$n"; done
# What was made: name, version, its source's sha256, a line each.
for n in $all; do if [ -f "$out/$n/key" ]; then echo "$n $(cat "$out/$n/version") $(cat "$out/$n/source")"; fi; done > "$out/record"
