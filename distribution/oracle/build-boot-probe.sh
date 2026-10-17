#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 || ! -x $1 ]]; then
  printf 'usage: %s STATIC-BUSYBOX OUTPUT.cpio.gz\n' "$0" >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
busybox=$(realpath -e -- "$1")
parent=$(realpath -e -- "$(dirname -- "$2")")
output=$parent/$(basename -- "$2")
if [[ -e $output ]]; then
  printf 'boot probe output already exists: %s\n' "$output" >&2
  exit 2
fi
# Fail before packaging an obsolete/minimal shell that cannot run this probe.
# The caller must select the BusyBox input belonging to the locked recipe,
# never the first cache directory returned by find.
"$busybox" sh -ec 'test "$((6 * 7))" -eq 42'
scratch=$(mktemp -d -- "$parent/.boot-probe.XXXXXXXX")
cleanup() {
  rm -f -- "$scratch/bin/busybox" "$scratch/bin/sh" "$scratch/init" "$scratch/image"
  rmdir -- "$scratch/bin" "$scratch/dev" "$scratch/proc" \
    "$scratch/sys" "$scratch/root" "$scratch/tmp" "$scratch"
}
trap cleanup EXIT HUP INT TERM
mkdir -- "$scratch/bin" "$scratch/dev" "$scratch/proc" \
  "$scratch/sys" "$scratch/root" "$scratch/tmp"
chmod 1777 "$scratch/tmp"
install -m 0755 -- "$busybox" "$scratch/bin/busybox"
ln -s busybox "$scratch/bin/sh"
install -m 0755 -- "$here/boot-probe-init" "$scratch/init"
(
  cd -- "$scratch"
  find . -mindepth 1 -print0 | LC_ALL=C sort -z |
    cpio --null -o --format=newc --owner=0:0 --reproducible 2>/dev/null
) | gzip -n -9 >"$scratch/image"
mv -- "$scratch/image" "$output"
printf 'boot probe initramfs: %s\n' "$output"
