#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
mkdir -p "$temporary/candidate/root/bin" \
  "$temporary/candidate/root/boot" "$temporary/opened"
printf '#!/bin/sh\nexit 0\n' > "$temporary/candidate/root/bin/busybox"
chmod 0755 "$temporary/candidate/root/bin/busybox"
ln "$temporary/candidate/root/bin/busybox" \
  "$temporary/candidate/root/bin/sh"
printf 'kernel-image\n' > "$temporary/candidate/root/boot/kernel"
printf 'initramfs-image\n' > "$temporary/candidate/root/boot/initramfs"
printf 'format=canonical-release-inputs-v4\nprofile=test\n' \
  > "$temporary/inputs"

for name in first second; do
  bash "$here/publish-native-bundle.sh" \
    "$temporary/candidate/root" "$temporary/inputs" \
    "$temporary/$name.tar.zst" >/dev/null
done
cmp "$temporary/first.tar.zst" "$temporary/second.tar.zst"
zstd -q -dc -- "$temporary/first.tar.zst" |
  tar -C "$temporary/opened" -xf -
cmp "$temporary/inputs" "$temporary/opened/manifest"
cmp "$temporary/candidate/root/bin/busybox" \
  "$temporary/opened/root/bin/busybox"
test "$(stat -c %i -- "$temporary/opened/root/bin/busybox")" = \
  "$(stat -c %i -- "$temporary/opened/root/bin/sh")"
cmp "$temporary/candidate/root/boot/kernel" \
  "$temporary/opened/root/boot/kernel"
if bash "$here/publish-native-bundle.sh" \
    "$temporary/candidate/root" "$temporary/inputs" \
    "$temporary/first.tar.zst" >/dev/null 2>&1; then
  printf 'native bundle overwrote an existing release\n' >&2
  exit 1
fi
printf 'native bundle: green (deterministic single download, ordinary root, hard links)\n'
