#!/bin/sh
# Build BusyBox as a static musl executable that keeps its relocations, the
# form xlat translates. Uses the distribution's pinned source and config.
#
#   xlat/userland/build-busybox.sh busybox-1.36.1.tar.bz2
#
# Needs musl-gcc and the Linux UAPI headers. Output: xlat/userland/out/busybox
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
tarball=$1
. "$repo/data/sources.env"
echo "$BUSYBOX_SHA256  $tarball" | sha256sum -c - >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xjf "$tarball" -C "$work"
src="$work/busybox-$BUSYBOX_VERSION"
# musl-gcc does not search the host's kernel headers; expose only those.
mkdir -p "$work/uapi"
for d in linux asm-generic mtd; do ln -s "/usr/include/$d" "$work/uapi/$d"; done
ln -s "/usr/include/$(gcc -dumpmachine)/asm" "$work/uapi/asm"
cp "$repo/data/config/busybox-$BUSYBOX_VERSION.config" "$src/.config"
make -C "$src" oldconfig CC=musl-gcc HOSTCC=gcc </dev/null >/dev/null
make -C "$src" -j"$(nproc)" busybox CC=musl-gcc HOSTCC=gcc \
  EXTRA_CFLAGS="-I$work/uapi" LDFLAGS="-static -Wl,--emit-relocs" >/dev/null
mkdir -p "$here/out"
cp "$src/busybox_unstripped" "$here/out/busybox"
"$here/out/busybox" --list > "$here/out/applets"
echo "$here/out/busybox ($(wc -l < "$here/out/applets") applets)"
