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
"$repo/src/v2/vm/build/boot-check" "$stage/root/boot/kernel" \
  "$stage/root/boot/initramfs" "$output/cmdline" 0x12e2000 >"$output/cmdline.log"
"$repo/src/v2/vm/build/boot-check" "$stage/root/boot/kernel" \
  "$stage/root/boot/initramfs" "$output/option" 0x12e4000 >"$output/option.log"
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
prefix --code-pages 0x12e3000 0x12e3d60 "$output/call.extra-page" \
  "$output/configure" >"$output/configure.log"
prefix --code-pages 0x12e3000 0x12e3d80 "$output/call.extra-page" \
  "$output/after-compare" >"$output/after-compare.log"
prefix --code-pages 0x12e2000 0x12e2a80 "$output/cmdline.extra-page" \
  "$output/cmdline-cut" >"$output/cmdline-cut.log"
prefix --code-pages 0x12e2000 0x12e2940 "$output/cmdline.extra-page" \
  "$output/cmdline-find" >"$output/cmdline-find.log"
prefix --code-pages 0x12e2000 0x12e294c "$output/cmdline.extra-page" \
  "$output/cmdline-body" >"$output/cmdline-body.log"
for witness in state:0x12e29aa char:0x12e29af word:0x12e29b3 \
    option:0x12e2970 compare:0x12e297b next:0x12e297f test:0x12e2988 \
    increment:0x12e298f rank:0x12e2998; do
  name=${witness%%:*}
  entry=${witness#*:}
  prefix --code-pages 0x12e2000 "$entry" "$output/cmdline.extra-page" \
    "$output/cmdline-$name" >"$output/cmdline-$name.log"
done
printf 'Bounded shipped startup witnesses prepared; Linux boot remains RED.\n'
