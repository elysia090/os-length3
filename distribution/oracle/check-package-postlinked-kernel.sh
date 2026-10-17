#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
kernel=$temporary/kernel
mkdir -p "$kernel/arch/x86/boot/compressed" "$temporary/opened"
printf 'original linked kernel\n' > "$kernel/vmlinux"
printf 'optimized kernel\n' > "$temporary/optimized"
printf '#!/bin/sh\nexit 0\n' > "$kernel/arch/x86/boot/compressed/mkpiggy"
chmod 0755 "$kernel/arch/x86/boot/compressed/mkpiggy"

for record in \
  arch/x86/boot/compressed/.vmlinux.bin.gz.cmd \
  arch/x86/boot/compressed/.piggy.S.cmd \
  arch/x86/boot/compressed/.piggy.o.cmd \
  arch/x86/boot/compressed/.vmlinux.cmd \
  arch/x86/boot/.zoffset.h.cmd \
  arch/x86/boot/.header.o.cmd \
  arch/x86/boot/.setup.elf.cmd \
  arch/x86/boot/.setup.bin.cmd \
  arch/x86/boot/.vmlinux.bin.cmd; do
  printf 'savedcmd_fixture := true\n' > "$kernel/$record"
done
printf '%s\n' "savedcmd_fixture := printf '%s\\n' '\$(pound)define ZO_fixture \$\$value' > arch/x86/boot/zoffset.h" \
  > "$kernel/arch/x86/boot/.zoffset.h.cmd"
printf '%s\n' "savedcmd_fixture := grep -xF '\$(pound)define ZO_fixture \$\$value' arch/x86/boot/zoffset.h > arch/x86/boot/header.o" \
  > "$kernel/arch/x86/boot/.header.o.cmd"
printf 'savedcmd_fixture := cp vmlinux arch/x86/boot/bzImage\n' \
  > "$kernel/arch/x86/boot/.bzImage.cmd"

cd "$temporary"
bash "$here/package-postlinked-kernel.sh" optimized kernel opened/bzImage \
  >/dev/null
cmp optimized opened/bzImage
printf '%s\n' '#define ZO_fixture $value' | cmp - kernel/arch/x86/boot/header.o
printf 'original linked kernel\n' | cmp - kernel/vmlinux

printf 'savedcmd_fixture := false\n' \
  > "$kernel/arch/x86/boot/compressed/.piggy.S.cmd"
if bash "$here/package-postlinked-kernel.sh" optimized kernel opened/failure \
    >/dev/null 2>&1; then
  printf 'failed Kbuild projection unexpectedly succeeded\n' >&2
  exit 1
fi
printf 'original linked kernel\n' | cmp - kernel/vmlinux
test ! -e opened/failure
printf 'savedcmd_fixture := false\n' > "$kernel/arch/x86/boot/.header.o.cmd"
printf 'savedcmd_fixture := true\n' \
  > "$kernel/arch/x86/boot/compressed/.piggy.S.cmd"
if bash "$here/package-postlinked-kernel.sh" optimized kernel opened/stale-header \
    >/dev/null 2>&1; then
  printf 'failed setup header rebuild unexpectedly succeeded\n' >&2
  exit 1
fi
test ! -e opened/stale-header
printf 'original linked kernel\n' | cmp - kernel/vmlinux
printf 'postlinked kernel package: green (offset/header rebuild, record escaping, failure restore)\n'
