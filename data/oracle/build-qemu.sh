#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
. "$data/sources.env"

# Nix shells replace TMPDIR with a per-shell directory. Keep the checkpoint
# outside that lifetime unless the caller deliberately selects another root.
root=${QM_ORACLE_BUILD_ROOT:-/tmp/libqm-x86-oracle}
source="$root/qemu-$QEMU_ORACLE_VERSION"
build="$root/qemu-build-$QEMU_ORACLE_VERSION"
archive="$data/upstream/qemu-$QEMU_ORACLE_VERSION.tar.xz"

"$here/fetch.sh"
mkdir -p "$root"
if [[ ! -d $source ]]; then
  tar -C "$root" -xf "$archive"
fi
if [[ ! -f $build/build.ninja ]]; then
  mkdir -p "$build"
  cd "$build"
  "$source/configure" \
    --target-list=x86_64-softmmu \
    --disable-docs \
    --disable-gtk \
    --disable-sdl \
    --disable-vnc \
    --disable-curl \
    --disable-gnutls \
    --disable-nettle \
    --disable-libssh \
    --disable-slirp \
    --disable-user \
    --enable-system \
    --enable-tcg
fi
ninja -C "$build" qemu-system-x86_64
printf '%s\n' "$build/qemu-system-x86_64"
