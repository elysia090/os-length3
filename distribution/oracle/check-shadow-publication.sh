#!/bin/sh
# Locked official sources and independent CPU. No browser execution backend.
set -eu
. distribution/sources.env
repo=$PWD
for role in table-call-input table-call-broken; do
    flags=; test "$role" != table-call-broken || flags=-DCLOBBER_ALIAS
    file=/tmp/$role.elf
    cc -nostdlib -fno-stack-protector -static -Wl,-no-pie,--emit-relocs,--build-id=none \
        $flags compiler/postlink-compiler/check/table-call-alias.S -o "$file"
    printf 'oracle-elf-begin %s %s\n' "$role" "$(sha256sum "$file" | cut -d ' ' -f 1)"
    zstd -q -c "$file" | base64
    printf 'oracle-elf-end\n'
done
set +e
make -C compiler/postlink-compiler -j4 table-call-alias-check dispatch-alias-check \
    nested-table-guards-check stack-slot-table-check copied-memory-table-check \
    chained-table-cut-check indirect-default-table-check
fixture_status=$?
set -e
printf 'shadow-publication:fixture-status:%s\n' "$fixture_status"
scratch=$(mktemp -d /tmp/shadow-publication.XXXXXXXX)
mkdir "$scratch/source" "$scratch/crypt" "$scratch/shadow" "$scratch/prefix"
for role in libxcrypt shadow; do
    case "$role" in libxcrypt) version=$LIBXCRYPT_VERSION; pin=$LIBXCRYPT_SHA256;; shadow) version=$SHADOW_VERSION; pin=$SHADOW_SHA256;; esac
    archive=distribution/upstream/$role-$version.tar.xz
    printf '%s  %s\n' "$pin" "$archive" | sha256sum -c -
    tar -xJf "$archive" -C "$scratch/source"
done
cd "$scratch/crypt"
CFLAGS='-O2 -std=gnu17' LDFLAGS='-static -Wl,--emit-relocs' \
    "$scratch/source/libxcrypt-$LIBXCRYPT_VERSION/configure" --prefix=/usr --libdir=/usr/lib \
    --disable-shared --enable-static --disable-obsolete-api --disable-werror
make -j4
make DESTDIR="$scratch/prefix" install
cd "$scratch/shadow"
CFLAGS='-O2 -std=gnu17' CPPFLAGS="-I$scratch/prefix/usr/include" \
    LDFLAGS="-static -Wl,--emit-relocs -L$scratch/prefix/usr/lib" \
    PKG_CONFIG_LIBDIR="$scratch/prefix/usr/lib/pkgconfig" \
    "$scratch/source/shadow-$SHADOW_VERSION/configure" --prefix=/usr --bindir=/usr/bin \
    --sbindir=/usr/bin --libdir=/usr/lib --disable-shared --enable-static --disable-nls \
    --disable-man --without-libpam --disable-logind --without-audit --without-selinux \
    --without-acl --without-attr --without-btrfs --without-nscd --without-sssd --without-libbsd
# This diagnostic builds SU and its actual libraries only. Other shadow
# commands have their own publication gate; their presence is not asserted.
for component in lib libsubid; do
    make -C "$component" LDFLAGS="-all-static -Wl,--emit-relocs -L$scratch/prefix/usr/lib" -j4
done
make -C src LDFLAGS="-all-static -Wl,--emit-relocs -L$scratch/prefix/usr/lib" -j4 su
cd "$repo"
cp distribution/config/passwd /etc/passwd
cp distribution/config/group /etc/group
cp distribution/config/shadow /etc/shadow
cp distribution/config/gshadow /etc/gshadow
cc -O2 -Wall -Wextra -Werror distribution/oracle/trace-userland.c -o "$scratch/trace"
compiler/postlink-compiler/build/postlink-compiler "$scratch/shadow/src/su" -o "$scratch/su-optimized"
for role in su-input su-optimized; do
    case "$role" in su-input) file=$scratch/shadow/src/su;; *) file=$scratch/su-optimized;; esac
    printf 'oracle-elf-begin %s %s\n' "$role" "$(sha256sum "$file" | cut -d ' ' -f 1)"
    zstd -q -c "$file" | base64
    printf 'oracle-elf-end\n'
done
failed=0
for executable in "$scratch/shadow/src/su" "$scratch/su-optimized"; do
    sha256sum "$executable"
    set +e
    "$scratch/trace" "$executable" -s /bin/sh nobody -c id >"$scratch/trace.log" 2>&1
    status=$?
    set -e
    cat "$scratch/trace.log"
    printf 'shadow-publication:status:%s:%s\n' "$executable" "$status"
    if test "$status" != 0; then failed=1; fi
done
test "$failed" = 0
test "$fixture_status" = 0
printf 'shadow-publication:PASS:original-and-optimized\n'
