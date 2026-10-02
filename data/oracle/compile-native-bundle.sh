#!/usr/bin/env bash
# Cold construction from the published native download, never guest execution.
set -euo pipefail
if [[ $# != 3 ]]; then
  printf 'usage: %s BUNDLE.tar.zst TRUSTED-SHA256 NEW-OUTPUT-DIRECTORY\n' "$0" >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(realpath -e -- "$here/../..")
bundle=$(realpath -e -- "$1")
digest=$2
parent=$(realpath -e -- "$(dirname -- "$3")")
leaf=$(basename -- "$3")
case $leaf in ''|.|..) exit 2;; esac
output=$parent/$leaf
if [[ ! $digest =~ ^[0-9a-f]{64}$ || -e $output ]]; then
  printf 'a trusted SHA256 and a new output directory are required\n' >&2
  exit 2
fi
# The digest must arrive from an authenticated channel, not this same archive.
actual=$(sha256sum -- "$bundle")
if [[ ${actual%% *} != "$digest" ]]; then
  printf 'native bundle authentication failed; no extraction or compilation\n' >&2
  exit 1
fi
mkdir -- "$output"
stage=$(mktemp -d -- "$output/.members.XXXXXXXX")
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT HUP INT TERM

make -C "$repo/src/v2" wasm-compiler >"$output/build.log" 2>&1
make -C "$repo/src/v2/vm" build/boot-check >>"$output/build.log" 2>&1
compiler=$repo/src/v2/wasm-compiler/build/wasm-compiler
# Include bin's hard-link owners: tar can name BusyBox as a hard link rather
# than as a payload. Extracting only that member with -O would silently lose
# its contents. This streams the archive once; it does not expand the root.
tar --zstd --no-same-owner --no-same-permissions -xf "$bundle" -C "$stage" \
  manifest root/boot/kernel root/boot/initramfs root/bin
test "$(head -n 1 -- "$stage/manifest")" = format=canonical-release-inputs-v4
test -f "$stage/root/bin/busybox"
cp -- "$stage/manifest" "$output/release-manifest"
{
  printf '%s  native-bundle\n' "$digest"
  for member in boot/kernel boot/initramfs bin/busybox; do
    sum=$(sha256sum -- "$stage/root/$member")
    printf '%s  root/%s\n' "${sum%% *}" "$member"
  done
} >"$output/source.sha256"

# The C loader alone derives setup/protected offsets and the 64-bit entry.
# No Kbuild vmlinux, guessed address, kernel patch or replacement initramfs.
"$repo/src/v2/vm/build/boot-check" "$stage/root/boot/kernel" \
  "$stage/root/boot/initramfs" "$output/boot" >"$output/boot.log"
page_address=$(sed -n 's/.*"kernelAddress":"\([0-9][0-9]*\)".*/\1/p' "$output/boot.json")
entry=$(sed -n 's/.*"entry":"\([0-9][0-9]*\)".*/\1/p' "$output/boot.json")
[[ $page_address =~ ^[0-9]+$ && $entry =~ ^[0-9]+$ ]]

prefix() {
  local result
  if "$compiler" "$@"; then result=0; else result=$?; fi
  if [[ $result != 3 ]]; then
    printf 'expected an explicit partial-construction result, got %s\n' "$result" >&2
    exit 1
  fi
}
prefix --code-pages "$page_address" "$entry" "$output/boot.kernel-page" \
  "$output/kernel" >"$output/kernel.log"
prefix --prefix "$stage/root/bin/busybox" "$output/busybox" >"$output/busybox.log"

# Preserve the real full-image red gate next to the useful compiled prefixes.
if "$compiler" "$stage/root/bin/busybox" "$output/busybox-whole.wasm" \
    >"$output/whole-image.log" 2>&1; then
  printf 'whole-image backend changed; update the execution acceptance oracle\n' >&2
  exit 1
fi
test ! -e "$output/busybox-whole.wasm"
grep -q 'incomplete' "$output/whole-image.log"
printf 'Native bundle -> C cold compiler: %s\n' "$output"
cat -- "$output/kernel.log" "$output/busybox.log"
printf 'Partial construction only: whole image and Linux browser boot remain RED.\n'
exit 3
