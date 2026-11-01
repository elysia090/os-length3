#!/bin/sh
# What of the root speaks to the network and keeps its secrets, made again from the sources this tree pins now
# (distribution/sources.env): OpenSSL, OpenSSH's client, curl and git. The 0.1.0 base was built from the pins of its
# day, and its own build (distribution/build.sh) needs its build host; these four take each release's security fixes
# here instead. Each is built as the base builds it (distribution/toolchain/build.sh: static, the same options and
# paths), against musl at the version the base has, as a static PIE with the standard hardening (stack protector,
# stack clash protection, CET, full RELRO), and put in place of the base's; the package database then says them
# (root-refresh-db.mjs).
#
#   sh scripts/root-refresh.sh ROOT [RECORD]
#
# ROOT is the root laid out for Prompts (root-release.sh: merged /usr). RECORD, when given, has a line for each
# component made: name, version and its source's sha256. Sources are kept in target/refresh by name, each checked
# against its pin before it is opened. Needs the host's C compiler (musl's wrapper drives it), make, perl (OpenSSL's
# Configure), curl, xz, node and the kernel's headers (linux-libc-dev).
set -eu
root=$1; record=${2:-/dev/null}
here=$(cd "$(dirname "$0")/.." && pwd)
. "$here/../distribution/sources.env"
src="$here/target/refresh"
mkdir -p "$src"
work=$(mktemp -d "${TMPDIR:-/tmp}/length3-refresh.XXXXXX")
trap 'rm -rf "$work"' EXIT
jobs=$(nproc)
: > "$record"

# NAME URL SHA256 VERSION: the source, checked against its pin, unpacked into $work/NAME.
get() {
  f="$src/$(basename "$2")"
  if ! echo "$3  $f" | sha256sum -c - >/dev/null 2>&1; then
    curl -fsSL --retry 4 -o "$f.part" "$2"
    echo "$3  $f.part" | sha256sum -c - >/dev/null || { echo "root-refresh: $2 is not the file pinned" >&2; exit 1; }
    mv "$f.part" "$f"
  fi
  mkdir -p "$work/$1"
  tar -xf "$f" -C "$work/$1" --strip-components=1
  echo "$1 $4 $3" >> "$record"
}

get musl "$MUSL_URL" "$MUSL_SHA256" "$MUSL_VERSION"
get zlib "$ZLIB_URL" "$ZLIB_SHA256" "$ZLIB_VERSION"
get openssl "$OPENSSL_URL" "$OPENSSL_SHA256" "$OPENSSL_VERSION"
get curl "$CURL_URL" "$CURL_SHA256" "$CURL_VERSION"
get git "$GIT_URL" "$GIT_SHA256" "$GIT_VERSION"
get openssh "$OPENSSH_URL" "$OPENSSH_SHA256" "$OPENSSH_VERSION"

# musl, as the base has it, with the kernel's headers beside its own (what OpenSSL and OpenSSH include of Linux's).
libc="$work/libc"
(cd "$work/musl" && ./configure --prefix="$libc" --disable-shared >/dev/null && make -s -j"$jobs" && make -s install)
for d in linux asm-generic; do cp -R "/usr/include/$d" "$libc/include/"; done
cp -R /usr/include/x86_64-linux-gnu/asm "$libc/include/asm"
cc="$libc/bin/musl-gcc"
hard='-O2 -fstack-protector-strong -fstack-clash-protection -fcf-protection'
pie='-static-pie -Wl,-z,relro,-z,now,-z,noexecstack'
dep="$work/dep"

(cd "$work/zlib" && CC="$cc" CFLAGS="$hard -fPIE" ./configure --prefix=/usr --static >/dev/null &&
  make -s -j"$jobs" && make -s DESTDIR="$dep" install)

# OpenSSL: its library and command, with its settings and certificates at /etc/ssl.
(cd "$work/openssl" && CC="$cc" ./Configure linux-x86_64 --prefix=/usr --libdir=lib --openssldir=/etc/ssl \
  no-shared no-tests no-module no-dso no-docs $hard -fPIE $pie >/dev/null &&
  make -s -j"$jobs" && make -s DESTDIR="$work/out/openssl" install_sw)
cp -R "$work/out/openssl/usr/." "$dep/usr/"

# curl: libcurl and its command, TLS by that OpenSSL, the root's CA bundle, nothing it could reach a server by
# that the base's leaves out.
(cd "$work/curl" && CC="$cc" CFLAGS="$hard -fPIE" CPPFLAGS="-I$dep/usr/include" LDFLAGS="$pie -L$dep/usr/lib" \
  LIBS='-pthread' PKG_CONFIG=pkg-config PKG_CONFIG_LIBDIR="$dep/usr/lib/pkgconfig" PKG_CONFIG_SYSROOT_DIR="$dep" \
  ./configure --prefix=/usr --disable-shared --enable-static --disable-docs --disable-manual \
    --disable-ldap --disable-ldaps --disable-rtsp \
    --with-openssl="$dep/usr" --with-zlib="$dep/usr" --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt \
    --without-brotli --without-libidn2 --without-libpsl --without-libssh2 --without-zstd --without-nghttp2 >/dev/null &&
  make -s -j"$jobs" CURL_LDFLAGS_BIN=-all-static && make -s DESTDIR="$work/out/curl" CURL_LDFLAGS_BIN=-all-static install)
cp -R "$work/out/curl/usr/." "$dep/usr/"

# git: no runtime languages (perl, python, tcl) and nothing the base's leaves out; its paths as the base has them.
gitflags="CC=$cc prefix=/usr NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease
  NO_EXPAT=YesPlease NO_REGEX=NeedsStartEnd OPENSSLDIR=$dep/usr"
(cd "$work/git" && make -s -j"$jobs" $gitflags CFLAGS="$hard -fPIE -I$dep/usr/include" \
  LDFLAGS="$pie -L$dep/usr/lib" CURL_CFLAGS="-I$dep/usr/include" \
  CURL_LDFLAGS="-L$dep/usr/lib -lcurl -lssl -lcrypto -lz -pthread" OPENSSL_LINK="-L$dep/usr/lib" all &&
  make -s $gitflags CFLAGS="$hard -fPIE -I$dep/usr/include" LDFLAGS="$pie -L$dep/usr/lib" \
  CURL_CFLAGS="-I$dep/usr/include" CURL_LDFLAGS="-L$dep/usr/lib -lcurl -lssl -lcrypto -lz -pthread" \
  OPENSSL_LINK="-L$dep/usr/lib" DESTDIR="$work/out/git" install)

# OpenSSH's client programs, its settings at /etc/ssh.
(cd "$work/openssh" && CC="$cc" CFLAGS="$hard -fPIE" CPPFLAGS="-I$dep/usr/include" LDFLAGS="$pie -L$dep/usr/lib" \
  LIBS='-pthread' ./configure --prefix=/usr --sysconfdir=/etc/ssh --with-ssl-dir="$dep/usr" --with-zlib="$dep/usr" \
    --without-pam --without-kerberos5 --without-libedit --without-ldns --without-selinux --without-zstd >/dev/null &&
  make -s -j"$jobs" ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan)
mkdir -p "$work/out/openssh-client/usr/bin"
for p in ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan; do
  install -m 0755 "$work/openssh/$p" "$work/out/openssh-client/usr/bin/$p"
done

# As the base's are: debug sections out (their symbols kept), and nothing the root has nothing to run with (OpenSSL's
# c_rehash is a perl script; the root has no perl, and its certificates come as one bundle).
rm -f "$work/out/openssl/usr/bin/c_rehash"
find "$work/out" -type f \( -perm -u+x -o -name '*.a' \) | while read -r f; do
  [ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = "177ELF" ] || [ "${f%.a}" != "$f" ] || continue
  strip --strip-debug "$f"
done

# Each in place of the base's: what the base's package had goes, what was made comes in (the database says which).
for p in openssl curl git openssh-client; do
  version=$(awk -v p="$p" '$1 == (p == "openssh-client" ? "openssh" : p) {print $2}' "$record")
  node "$here/scripts/root-refresh-db.mjs" "$root" "$p" "$version" "$work/out/$p"
done
