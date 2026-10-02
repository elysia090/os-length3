#!/usr/bin/env bash
# Fixed published-startup witness, not a compiler/boot execution fallback.
set -euo pipefail
if [[ $# != 3 ]]; then
  printf 'usage: %s BUNDLE.tar.zst TRUSTED-SHA256 NEW-OUTPUT-DIRECTORY\n' "$0" >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(realpath -e -- "$here/../..")
bundle=$(realpath -e -- "$1")
if bash "$here/compile-native-bundle.sh" "$@"; then result=0; else result=$?; fi
[[ $result == 3 ]]
output=$(realpath -e -- "$3")
# These source coordinates are only valid for this exact shipped kernel.
grep -qx '21771c757255406ce090faa6c5108b72618f794c8e46379a4a3d50dc21364e67  root/boot/kernel' "$output/source.sha256"
stage=$(mktemp -d -- "$output/.startup.XXXXXXXX")
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT HUP INT TERM
tar --zstd --no-same-owner --no-same-permissions -xf "$bundle" -C "$stage" \
  root/boot/kernel root/boot/initramfs
"$repo/src/v2/vm/build/boot-check" "$stage/root/boot/kernel" \
  "$stage/root/boot/initramfs" "$output/call" 0x12e3000 >"$output/call.log"
prefix() {
  if "$repo/src/v2/wasm-compiler/build/wasm-compiler" "$@"; then result=0; else result=$?; fi
  [[ $result == 3 ]]
}
prefix --code-pages 0x1000000 0x1000245 "$output/boot.kernel-page" \
  "$output/after-return" >"$output/after-return.log"
prefix --code-pages 0x12e3000 0x12e3bb0 "$output/call.extra-page" \
  "$output/idt" >"$output/idt.log"
prefix --code-pages 0x1000000 0x100024d "$output/boot.kernel-page" \
  "$output/control-read" >"$output/control-read.log"
printf 'Bounded shipped startup witnesses prepared; Linux boot remains RED.\n'
