#!/usr/bin/env bash
# System reference fixture, not Linux or a product execution backend.
set -euo pipefail
case "$#:${2-}" in
  1:|2:misc) ;;
  *) printf 'usage: prepare-msr.sh OUTPUT-DIRECTORY [misc]\n' >&2; exit 2 ;;
esac
test ! -e "$1" || { printf 'output already exists\n' >&2; exit 2; }
mkdir -p "$1"
case "${2-}" in
  misc) as --32 --defsym MISC_CASES=1 data/oracle/msr-entry.S -o "$1/entry.o" ;;
  '') as --32 data/oracle/msr-entry.S -o "$1/entry.o" ;;
esac
ld -m elf_i386 -T data/oracle/exception-entry.ld "$1/entry.o" -o "$1/entry.elf"
printf 'System-mode MSR fixture prepared; not Linux boot\n'
