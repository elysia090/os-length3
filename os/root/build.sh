#!/bin/sh
# OS Length3 Linux's root, package by package: each made from the source this tree pins (root/sources.env) by its
# recipe (root/packages/NAME.sh), on one machine, Alpine 3.24 at the digest CI names
# (x86_64-alpine-linux-musl, the root's target), with one libc (Alpine's musl, at the version the root's own musl is
# made from, with the same security fixes), static, hardened, stripped, and nothing done to it after the linker.
#
#   sh root/build.sh OUT [NAME...]
#
# Each package is made only when what it is made of changed. Its key is the digest of its recipe, the pins it
# names, its patches and other inputs, this script, the compiler, linker and libc it is built with, and the keys of
# the packages it builds against: OUT/NAME holds what its install put there (tree/), its key, version and source
# digest, and is made again only when its key is not the one there. NAMEs given are made (with what they need);
# none, every one. Run as root (CI runs it in its container); OWNER (uid:gid) given, OUT is that user's when it ends,
# however it ends. Sources are kept in OUT/../root-src by pin and name, each checked against its pin before it is
# opened.
#
# A recipe is sh, read in a shell of its own, saying:
#   pins="NAME..."      the sources.env prefixes it is made from (NAME_VERSION, NAME_URL, NAME_SHA256 or _SHA512);
#                       the first unpacked where it is built, the others by `unpack NAME DIR`
#   needs="PKG..."      packages it builds against: their trees, together, are $deps, which CPPFLAGS, LDFLAGS and
#                       pkg-config point to (and nothing of the build machine's own besides its libc and kernel headers)
#   tools="APK..."      Alpine packages it is built with, added for its build and check alone and taken away after
#                       (so none reaches another package's build unseen); their versions are in its key
#   patches="FILE..."   under root/packages/, applied in order (-p1)
#   inputs="FILE..."    other files of root/ it is made from (from root/: etc/passwd), in its key too; $here is root/
#   flat=1              its first pin's archive has no top directory to take off (tzdata's)
#   version=V           its version, where it has no pin to take it from (the root's own settings)
#   build() { ... }     run in the unpacked source; installs into $dest as the root lays it out (/usr, /etc)
#   check() { ... }     optional: run after it is made, against what is in $dest (with what it needs in $deps); a
#                       package that does not do what it is for is not made
#
# Every build is given the same flags (a recipe that departs from them says why): C17 (Alpine's GCC writes C23 by
# default, which code written for C17 does not build as), the stack protector, stack clash protection and CET, and
# static links with full RELRO and no executable stack; Alpine's GCC makes position-independent code and links
# -static as a static PIE, and defines _FORTIFY_SOURCE; every program made is checked to be such a PIE, with full
# RELRO and no executable stack. A library comes with what building against it needs (its headers, archive and
# pkg-config file), not its libtool archive; no package keeps manuals, translations, shell completions or desktop
# entries and icons (the root has no man, no locales and no desktop, and its interactive shell is ash, whose
# completions are its own). Nothing a package made names where it was made: what it says of what it was built
# against is said as the root has it, a recipe whose build names its sources by where they are says them from their
# top, and a package that still names its build's place is not made. Every script it made is for sh or bash, the
# root's languages.
set -eu
out=$1; shift
here=$(cd "$(dirname "$0")" && pwd)
recipes="$here/packages"
pins_file="$here/sources.env"
. "$pins_file"
say() { echo "root-build: $*" >&2; }
grep -q '^3\.24\.' /etc/alpine-release 2>/dev/null || { say "run on Alpine 3.24 (the root's target)"; exit 2; }

# What every recipe is built with. Each one's own tools are added as it is made, from packages kept here once fetched.
mkdir -p /etc/apk/cache
apk update -q
apk add -q build-base linux-headers curl xz bzip2 tar patch unzip
target=$(gcc -dumpmachine)
[ "$target" = x86_64-alpine-linux-musl ] || { say "this compiler targets $target, not x86_64-alpine-linux-musl"; exit 2; }
# An installed Alpine package's version, as its database says it; and the version of one this machine would install.
installed() { awk -v p="$1" '/^P:/ {n = substr($0, 3)} /^V:/ && n == p {print substr($0, 3)}' /lib/apk/db/installed; }
offered() { apk search -x "$1" | while read -r l; do echo "${l#"$1"-}"; done; }
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

# NAME: the pins' lines it is made of, as sources.env says them.
pinned() { for p in $(field "$1" pins); do grep "^${p}_" "$pins_file" || { say "$1: no pin $p"; exit 1; }; done; }
key_of() {
  { echo "$machine"; cat "$recipes/$1.sh"; pinned "$1"
    for p in $(field "$1" patches); do echo "$p"; cat "$recipes/$p"; done
    for f in $(field "$1" inputs); do echo "$f"; cat "$here/$f"; done
    for n in $(field "$1" needs); do echo "$n $(cat "$out/$n/key")"; done
    # The tools it is built with, at the versions this machine installs (a Rust or Go program is its compiler's).
    for t in $(field "$1" tools); do echo "$t $(offered "$t")"; done
  } | sha256sum | cut -d' ' -f1
}

# PIN DIR [flat]: the pinned source, checked against its digest, unpacked into DIR (its top directory taken off,
# unless flat; a file that is no archive, as the CA bundle, put there as it is). A crate (crates.io's) is a tar; a
# zip from Go's module proxy has the module and its version as its top (path@version/), which is what is taken off.
unpack() {
  url=$(eval "echo \"\${$1_URL}\""); sum=$(eval "echo \"\${$1_SHA256:-}\""); alg=sha256
  [ -n "$sum" ] || { sum=$(eval "echo \"\${$1_SHA512}\""); alg=sha512; }
  f="$src/$1-$(basename "$url")"
  # A maker's site may answer once with something else (a CDN's page, a cut-off file): it is asked again, and only
  # the file pinned is ever taken.
  tries=0
  while ! echo "$sum  $f" | ${alg}sum -c - >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 3 ]; then
      say "$url is not the file pinned: $(wc -c < "$f.part") bytes, $(head -c 64 "$f.part" | od -An -c | tr -s ' ' | head -c 60)"
      exit 1
    fi
    [ "$tries" = 1 ] || sleep $((tries * 5))
    curl -fsSL --retry 4 -o "$f.part" "$url" && echo "$sum  $f.part" | ${alg}sum -c - >/dev/null 2>&1 && mv "$f.part" "$f"
  done
  mkdir -p "$2"
  case $f in
    *.tar.*|*.tgz|*.crate) if [ "${3:-}" = flat ]; then tar -xf "$f" -C "$2"; else tar -xf "$f" -C "$2" --strip-components=1; fi ;;
    *.zip)
      rm -rf "${2:?}.zip"; unzip -q "$f" -d "$2.zip"
      top=$(unzip -Z1 "$f" | head -n 1 | sed -n 's|^\([^@]*@[^/]*\)/.*|\1|p')
      if [ "${3:-}" = flat ] || [ -z "$top" ]; then cp -a "$2.zip/." "$2/"; else cp -a "$2.zip/$top/." "$2/"; fi
      rm -rf "${2:?}.zip" ;;
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
  tools=$(field "$name" tools)
  [ -z "$tools" ] || apk add -q --virtual ".tools-$name" $tools
  say "$name: making"
  (
    cd "$w/src"
    dest=$t; deps="$w/deps"
    ld='-Wl,-z,relro,-z,now,-z,noexecstack'
    # What it builds against is pointed to only where it builds against something (a build may write its flags
    # down: OpenSSL's are in every program linked with it).
    with=; [ -z "$(field "$name" needs)" ] || with=1
    export CC=gcc CXX=g++ AR=ar RANLIB=ranlib \
      CFLAGS='-O2 -std=gnu17 -fstack-protector-strong -fstack-clash-protection -fcf-protection' \
      CXXFLAGS='-O2 -fstack-protector-strong -fstack-clash-protection -fcf-protection' \
      CPPFLAGS="${with:+-I$deps/usr/include}" LDFLAGS="-static $ld${with:+ -L$deps/usr/lib}" \
      PKG_CONFIG=pkg-config PKG_CONFIG_LIBDIR="$deps/usr/lib/pkgconfig" PKG_CONFIG_SYSROOT_DIR="$deps"
    # libtool takes -static as "prefer static libraries" and links a dynamic program: at make time it is told
    # -all-static, which it passes on.
    allstatic="-all-static $ld${with:+ -L$deps/usr/lib}"
    # What is written in Rust or Go is built as the rest is: static PIEs with full RELRO and no executable stack,
    # their dependencies exactly as their lockfiles say (cargo --locked; go -mod=readonly, each module checked
    # against Go's checksum database), fetched into this build's own place, and nothing of that place in what they
    # make (rustc's --remap-path-prefix, go's -trimpath; the C a crate builds, by the name only Rust's cc crate
    # reads, -ffile-prefix-map). Go links through GCC, as a static PIE ($golink, inside a recipe's -ldflags).
    export CARGO_HOME="$w/cargo" CARGO_TARGET_DIR="$w/target" \
      RUSTFLAGS="-C target-feature=+crt-static -C relocation-model=pie -C link-arg=$ld --remap-path-prefix=$w/=" \
      "CFLAGS_$(echo "$target" | tr - _)=$CFLAGS -ffile-prefix-map=$w/=" \
      GOPATH="$w/go" GOCACHE="$w/go-cache" GOTOOLCHAIN=local \
      GOFLAGS='-trimpath -mod=readonly -buildvcs=false -buildmode=pie' \
      CGO_ENABLED=1 CGO_CFLAGS='-O2 -fstack-protector-strong -fstack-clash-protection -fcf-protection' CGO_LDFLAGS="$ld"
    golink='-linkmode=external -extldflags=-static-pie'
    eval "$fields"
    . "$recipes/$name.sh"
    build
  ) > "$w/log" 2>&1 || { tail -n 100 "$w/log" >&2; say "$name: its build failed (the end of its log is above)"; exit 1; }
  # Laid out as the root is: /bin, /sbin and /lib are /usr's.
  for d in bin sbin lib; do
    [ -d "$t/$d" ] && [ ! -L "$t/$d" ] || continue
    mkdir -p "$t/usr/$d"; cp -a "$t/$d/." "$t/usr/$d/"; rm -rf "${t:?}/${d:?}"
  done
  for d in usr/share/man usr/man usr/share/doc usr/share/info usr/share/locale usr/share/gtk-doc usr/share/bash-completion \
    usr/share/applications usr/share/icons usr/share/pixmaps; do
    rm -rf "${t:?}/$d"
  done
  find "$t" -name '*.la' -type f -delete
  # What it writes down of what it was built against (a pkg-config file, a -config script) it says as the root has
  # it: the deps are laid out as the root is, so the deps' /usr is /usr. Only text is written to.
  grep -rlF "$w/deps" "$t" 2>/dev/null | while read -r f; do
    if [ ! -L "$f" ] && tr -d '\000' < "$f" | cmp -s - "$f"; then sed -i "s|$w/deps||g" "$f"; fi
  done
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
  # And hardened as every build is asked to make it: position-independent (where ASLR puts it), its relocations
  # read-only before it runs (full RELRO: GNU_RELRO and BIND_NOW), its stack not executable.
  soft=$(find "$t" -type f -perm -u+x | while read -r f; do
    is_elf "$f" || continue
    h=$(readelf -hld "$f" 2>/dev/null)
    if ! echo "$h" | grep -q 'Type: *DYN'; then echo "${f#"$t/"} (not position-independent)"
    elif ! echo "$h" | grep -q GNU_RELRO || ! echo "$h" | grep -qE 'BIND_NOW|FLAGS_1.*NOW'; then echo "${f#"$t/"} (not full RELRO)"
    elif echo "$h" | grep -A1 GNU_STACK | grep -q RWE; then echo "${f#"$t/"} (executable stack)"
    fi
  done)
  [ -z "$soft" ] || { say "$name: not hardened: $soft"; exit 1; }
  # Every script it made runs in the root: by sh or bash, the root having no other language (git's sample hooks,
  # which nothing runs until a person renames one, aside).
  stray=$(find "$t" -type f -perm -u+x ! -name '*.sample' | while read -r f; do
    l=$(head -c 128 "$f" | head -n 1 | tr -d '\000')
    case $l in '#!'*) ;; *) continue ;; esac
    set -f; set -- ${l#??}; set +f
    [ "${1:-}" != /usr/bin/env ] || shift
    case ${1##*/} in sh|bash) ;; *) echo "${f#"$t/"} (${1:-nothing})" ;; esac
  done)
  [ -z "$stray" ] || { say "$name: scripts for a language the root has not: $stray"; exit 1; }
  # Nothing it made names where it was made.
  named=$(grep -rlF "$w" "$t" 2>/dev/null | sed "s|^$t/||" | tr '\n' ' ')
  [ -z "$named" ] || { say "$name: names where it was made ($w): $named"; exit 1; }
  # What it is for, done by what was made.
  (
    cd "$w"; dest=$t; deps="$w/deps"
    eval "$fields"; check() { :; }
    . "$recipes/$name.sh"
    check
  ) > "$w/check" 2>&1 || { cat "$w/check" >&2; say "$name: made, but its check failed (above)"; exit 1; }
  [ -z "$tools" ] || apk del -q ".tools-$name"
  v=$(field "$name" version)
  [ -n "$v" ] || [ -z "$first" ] || v=$(eval "echo \"\${${first}_VERSION:-\${${first}_DATE:-}}\"")
  echo "${v:-0}" > "$out/$name/version"
  if [ -n "$first" ]; then
    url=$(eval "echo \"\${${first}_URL}\""); sha256sum "$src/$first-$(basename "$url")" | cut -d' ' -f1 > "$out/$name/source"
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
