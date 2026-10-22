#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
  printf 'usage: %s INSTALLED-ROOT RELEASE-INPUTS OUTPUT.tar.zst\n' "$0" >&2
  exit 2
fi

root=$(realpath -e -- "$1")
inputs=$(realpath -e -- "$2")
output_parent=$(realpath -e -- "$(dirname -- "$3")")
output=$output_parent/$(basename -- "$3")

if [[ $(basename -- "$root") != root || ! -d $root \
      || ! -f $root/boot/kernel || ! -f $root/boot/initramfs \
      || ! -x $root/bin/busybox || ! -f $inputs \
      || $(head -n 1 -- "$inputs") != format=canonical-release-inputs-v4 ]]; then
  printf 'native bundle requires the checked installed root and inputs\n' >&2
  exit 2
fi
case $output in
  *.tar.zst) ;;
  *) printf 'native bundle output must end in .tar.zst\n' >&2; exit 2 ;;
esac
if [[ -e $output ]]; then
  printf 'native bundle output already exists: %s\n' "$output" >&2
  exit 2
fi

stage=$(mktemp -d -- "$output_parent/.native-bundle.XXXXXXXX")
temporary=$stage/bundle.tar.zst
cleanup() {
  rm -f -- "$temporary" "$stage/manifest"
  rmdir -- "$stage"
}
trap cleanup EXIT HUP INT TERM
cp -- "$inputs" "$stage/manifest"

# Package ownership and hard-link identity have already been checked in the
# installed root. Tar records each linked inode once; zstd is transport-only.
# The sorted, normalized stream is reproducible and never re-runs post-link.
tar --sort=name --format=posix \
  --pax-option=delete=atime,delete=ctime \
  --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$stage" -cf - manifest \
  -C "$(dirname -- "$root")" root |
  zstd -q -19 -T1 -o "$temporary"
zstd -q -t -- "$temporary"
if ! zstd -q -dc -- "$temporary" | tar -tf - | \
    grep -xF 'root/boot/kernel' >/dev/null; then
  printf 'native bundle is missing its kernel member\n' >&2
  exit 1
fi
mv -- "$temporary" "$output"
printf 'native bundle: %s (%s bytes, sha256=%s)\n' \
  "$output" "$(stat -c %s -- "$output")" \
  "$(sha256sum "$output" | cut -d' ' -f1)"
