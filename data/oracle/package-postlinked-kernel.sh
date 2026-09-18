#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
  printf 'usage: %s OPTIMIZED-VMLINUX KERNEL-BUILD OUTPUT-BZIMAGE\n' "$0" >&2
  exit 2
fi

optimized_vmlinux=$1
kernel_build=$2
output_bzimage=$3

if [[ ! -f $optimized_vmlinux || ! -f $kernel_build/vmlinux \
      || ! -x $kernel_build/arch/x86/boot/compressed/mkpiggy \
      || $output_bzimage == "$kernel_build/arch/x86/boot/bzImage" ]]; then
  printf 'invalid optimized kernel, Kbuild tree, or output path\n' >&2
  exit 2
fi

temporary=$(mktemp -d)
cp -p "$kernel_build/vmlinux" "$temporary/vmlinux"
restore_vmlinux() {
  cp -p "$temporary/vmlinux" "$kernel_build/vmlinux"
  rm -rf "$temporary"
}
trap restore_vmlinux EXIT HUP INT TERM

cp "$optimized_vmlinux" "$kernel_build/vmlinux"
cd "$kernel_build"

saved_command() {
  local record=$1
  local command
  command=$(sed -n 's/^savedcmd_[^:]* := //p' "$record")
  if [[ -z $command ]]; then
    printf 'missing saved Kbuild command: %s\n' "$record" >&2
    return 1
  fi
  sh -c "$command"
}

# The accepted optimized ELF has already discarded its construction-only
# section table.  Kbuild's first objcopy step strips those same sections from
# an ordinary linked vmlinux; applying it again to a sectionless ELF would
# retain only the ELF headers.  Its normal form is therefore an identity copy.
# Every subsequent compression, decompressor-link, and setup projection is the
# exact Kbuild-recorded command.
cp vmlinux arch/x86/boot/compressed/vmlinux.bin
saved_command arch/x86/boot/compressed/.vmlinux.bin.gz.cmd
saved_command arch/x86/boot/compressed/.piggy.S.cmd
saved_command arch/x86/boot/compressed/.piggy.o.cmd
saved_command arch/x86/boot/compressed/.vmlinux.cmd
saved_command arch/x86/boot/.vmlinux.bin.cmd
saved_command arch/x86/boot/.bzImage.cmd

mkdir -p "$(dirname -- "$output_bzimage")"
cp arch/x86/boot/bzImage "$output_bzimage"
printf '%s\n' "$output_bzimage"
