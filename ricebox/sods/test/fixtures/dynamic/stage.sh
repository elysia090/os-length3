#!/bin/sh
# The digest was pinned from the signed Debian trixie Packages index.
# Extract payloads only. No download, install, package hooks, or launcher.
set -eu
[ "$#" -eq 2 ] || { echo "usage: sh stage.sh LIBC6_DEB NEW_FIXTURE_ROOT" >&2; exit 2; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deb=$1
out=$2
name=libc6_2.41-12+deb13u5_amd64.deb
[ "${deb##*/}" = "$name" ] && [ -f "$deb" ] && [ ! -L "$deb" ] || { echo "expected the exact regular Debian libc6 archive" >&2; exit 2; }
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
cp -- "$deb" "$scratch/$name"
(cd -- "$scratch" && sha256sum -c "$here/libc6.sha256")
[ "$(dpkg-deb -f "$scratch/$name" Package)" = libc6 ]
[ "$(dpkg-deb -f "$scratch/$name" Version)" = '2.41-12+deb13u5' ]
[ "$(dpkg-deb -f "$scratch/$name" Architecture)" = amd64 ]
mkdir -- "$out"
out=$(CDPATH= cd -- "$out" && pwd)
dpkg-deb -x "$scratch/$name" "$out"
ln -s usr/lib "$out/lib"
ln -s usr/lib64 "$out/lib64"
mkdir -p -- "$out/usr/bin"
lib="$out/usr/lib/x86_64-linux-gnu"
[ "$(readlink "$out/usr/lib64/ld-linux-x86-64.so.2")" = ../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 ]
[ -f "$out/lib64/ld-linux-x86-64.so.2" ] && [ -f "$lib/libc.so.6" ]
cc=${SODS_FIXTURE_CC:-cc}
env -i PATH="$PATH" LC_ALL=C "$cc" -march=x86-64 -fPIC -shared -s -Wl,-soname,libricebox-pie-fixture.so.1 \
    -Wl,-z,relro,-z,now -o "$lib/libricebox-pie-fixture.so.1" "$here/library.c"
env -i PATH="$PATH" LC_ALL=C "$cc" -march=x86-64 -fPIE -pie -s -Wl,-z,relro,-z,now \
    -Wl,--dynamic-linker=/lib64/ld-linux-x86-64.so.2 -Wl,-rpath,'$ORIGIN/../lib/x86_64-linux-gnu' \
    -o "$out/usr/bin/ricebox-pie-fixture" "$here/main.c" -L"$lib" -l:libricebox-pie-fixture.so.1
