#!/bin/sh
# The root's C toolchain made from the sources this tree pins (distribution/sources.env): GNU make, binutils and GCC
# (C, with GMP, MPFR and MPC built inside it), each static, with the options the base's own build gives them
# (distribution/toolchain/build.sh), stripped, and nothing done to them after the linker. The base's were rewritten
# by a post-link compiler, and its cc1 wrote nearly every floating literal wrong (`7.3 * 12` was 57); these go in
# their place (root-release.sh, through root-refresh-db.mjs as root-refresh.sh's do).
#
#   sh scripts/root-toolchain.sh OUT
#
# Run on Alpine 3.24 (x86_64-alpine-linux-musl, the base's target: its own GCC and musl build these, C++ and all),
# as root, as CI does in its container. OUT gets make/, binutils/ and gcc/, each what its install put there
# (DESTDIR), and `record`, a line each: name, version, its source's sha256. Sources are kept in OUT/../toolchain-src
# by name, each checked against its pin before it is opened.
set -eu
out=$1
here=$(cd "$(dirname "$0")/.." && pwd)
. "$here/../distribution/sources.env"
grep -q '^3\.24\.' /etc/alpine-release 2>/dev/null || { echo "root-toolchain: run on Alpine 3.24 (its target is the base's)" >&2; exit 2; }
apk add --no-cache -q build-base bison flex perl curl xz bzip2 linux-headers
target=$(gcc -dumpmachine)
[ "$target" = x86_64-alpine-linux-musl ] || { echo "root-toolchain: this compiler targets $target, the base's GCC x86_64-alpine-linux-musl" >&2; exit 2; }
mkdir -p "$out"
out=$(cd "$out" && pwd)
src="$out/../toolchain-src"
mkdir -p "$src"
work=$(mktemp -d "${TMPDIR:-/tmp}/length3-toolchain.XXXXXX")
trap 'rm -rf "$work"' EXIT
jobs=$(nproc)
# Alpine 3.24's GCC writes C23 by default, where `char *getenv ();` (make's gnulib, GMP's configure) declares a
# function of no arguments: what the host compiler builds is C17, and is built as such. What the GCC made builds
# (libgcc) is GCC's own and written for its default (C23: `bool` a keyword), so it is given its flags apart.
c17='-O2 -std=gnu17'
record="$out/record"
: > "$record"

# NAME URL SUM VERSION [sha512]: the source, checked against its pin (sha256, or sha512), unpacked into $work/NAME.
get() {
  f="$src/$(basename "$2")"
  sum=sha256sum; [ "${5:-}" = sha512 ] && sum=sha512sum
  if ! echo "$3  $f" | $sum -c - >/dev/null 2>&1; then
    curl -fsSL --retry 4 -o "$f.part" "$2"
    echo "$3  $f.part" | $sum -c - >/dev/null || { echo "root-toolchain: $2 is not the file pinned" >&2; exit 1; }
    mv "$f.part" "$f"
  fi
  mkdir -p "$work/$1"
  tar -xf "$f" -C "$work/$1" --strip-components=1
  echo "$1 $4 $(sha256sum "$f" | cut -d' ' -f1)" >> "$record"
}

get make "$MAKE_URL" "$MAKE_SHA256" "$MAKE_VERSION"
get binutils "$BINUTILS_URL" "$BINUTILS_SHA256" "$BINUTILS_VERSION"
get gcc "$GCC_URL" "$GCC_SHA256" "$GCC_VERSION"
echo "$GCC_SHA512  $src/$(basename "$GCC_URL")" | sha512sum -c - >/dev/null || { echo "root-toolchain: GCC's sha512 is not the one pinned" >&2; exit 1; }
get gmp "$GMP_URL" "$GMP_SHA512" "$GMP_VERSION" sha512
get mpfr "$MPFR_URL" "$MPFR_SHA512" "$MPFR_VERSION" sha512
get mpc "$MPC_URL" "$MPC_SHA512" "$MPC_VERSION" sha512
# GCC builds them inside itself, as the base's did, so cc1 links them statically.
for d in gmp mpfr mpc; do mv "$work/$d" "$work/gcc/$d"; done

# make
(cd "$work/make" && CFLAGS="$c17" LDFLAGS='-static' ./configure --prefix=/usr --disable-nls >/dev/null &&
  make -s -j"$jobs" && make -s DESTDIR="$out/make" install)

# binutils: as the base's (its programs all-static: libtool reads -static as "prefer static libraries").
mkdir -p "$work/binutils-o"
(cd "$work/binutils-o" && CFLAGS="$c17 -static" CXXFLAGS='-O2 -static' LDFLAGS='-static' MAKEINFO=true \
  "$work/binutils/configure" --prefix=/usr --build="$target" --host="$target" --target="$target" \
    --disable-gold --disable-gdb --disable-gdbserver --disable-gprofng --disable-libdecnumber --disable-nls \
    --disable-readline --disable-shared --disable-sim --disable-werror --enable-static --without-babeltrace \
    --without-debuginfod --without-zstd >/dev/null)
make -s -C "$work/binutils-o" MAKEINFO=true LDFLAGS='-static' -j"$jobs" all-binutils all-gas all-ld
for d in binutils gas ld; do
  make -s -C "$work/binutils-o/$d" clean
  make -s -C "$work/binutils-o/$d" MAKEINFO=true LDFLAGS='-all-static' -j"$jobs"
done
make -s -C "$work/binutils-o" MAKEINFO=true LDFLAGS='-static' DESTDIR="$out/binutils" install-binutils install-gas install-ld

# GCC: C, as the base's, its libgcc built by the GCC just made.
mkdir -p "$work/gcc-o"
(cd "$work/gcc-o" && CFLAGS="$c17" CXXFLAGS='-O2' LDFLAGS='-static' CFLAGS_FOR_TARGET='-O2' CXXFLAGS_FOR_TARGET='-O2' \
  "$work/gcc/configure" --prefix=/usr --build="$target" --host="$target" --target="$target" \
    --enable-languages=c --disable-lto --disable-bootstrap --disable-multilib --disable-nls --disable-shared \
    --enable-static --disable-libatomic --disable-libgomp --disable-libquadmath --disable-libsanitizer \
    --disable-libssp --disable-libstdcxx-pch --disable-libvtv --without-isl --without-zstd --with-sysroot=/ \
    --with-native-system-header-dir=/usr/include >/dev/null)
make -s -C "$work/gcc-o" -j"$jobs" all-gcc all-target-libgcc
make -s -C "$work/gcc-o" DESTDIR="$out/gcc" install-gcc install-target-libgcc
# `cc`, as the base has it: the name make and every build reaches for.
ln -sf gcc "$out/gcc/usr/bin/cc"
# What no Prompt reads: the manuals and GCC's plugin headers.
rm -rf "$out/make/usr/share" "$out/binutils/usr/share" "$out/gcc/usr/share" "$out/gcc/usr/lib/gcc/$target/$GCC_VERSION/plugin"

# Stripped, and nothing else: debug sections and symbols out of each program; the archives and objects GCC links
# programs with keep their symbols (a link needs them) and lose only their debug sections.
for f in $(find "$out/make" "$out/binutils" "$out/gcc" -type f); do
  [ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = "177ELF" ] || [ "${f%.a}" != "$f" ] || continue
  case $f in
    *.a|*.o) strip --strip-debug "$f" ;;
    *) strip --strip-all "$f" ;;
  esac
done

# Each program stands alone (static, no interpreter), and the compiler is right: a program with floating literals
# built with it, run, says what C says.
bad=$(for f in $(find "$out" -type f -perm -u+x); do
  [ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = "177ELF" ] || continue
  interp=$(readelf -l "$f" | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
  [ -z "$interp" ] || echo "${f#"$out/"} (interpreter $interp)"
done)
[ -z "$bad" ] || { echo "root-toolchain: not static:" >&2; echo "$bad" >&2; exit 1; }
printf '%s\n' '#include <stdio.h>' 'int main(void) { double f[] = {6.5, 7.3, 0.1}; int i = 7.3 * 12;' \
  '  printf("%.17g %.17g %.17g %d\n", f[0], f[1], f[2], i); return 0; }' > "$work/literals.c"
gcc_root="$out/gcc/usr"
"$gcc_root/bin/gcc" -B"$gcc_root/libexec/gcc/$target/$GCC_VERSION/" -B"$out/binutils/usr/bin/" -O1 -o "$work/literals" "$work/literals.c"
said=$("$work/literals")
[ "$said" = '6.5 7.2999999999999998 0.10000000000000001 87' ] || { echo "root-toolchain: the GCC made compiles literals wrong: $said" >&2; exit 1; }
echo "root-toolchain: make $MAKE_VERSION, binutils $BINUTILS_VERSION, gcc $GCC_VERSION ($said)"
