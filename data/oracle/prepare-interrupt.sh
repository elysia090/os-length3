#!/usr/bin/env bash
set -euo pipefail
test "$#" = 1 || { printf 'usage: prepare-interrupt.sh OUTPUT-DIRECTORY\n' >&2; exit 2; }
test ! -e "$1" || { printf 'output already exists\n' >&2; exit 2; }
mkdir -p "$1"
as --32 data/oracle/interrupt-entry.S -o "$1/entry.o"
ld -m elf_i386 -T data/oracle/exception-entry.ld "$1/entry.o" -o "$1/entry.elf"
printf 'Independent PIT/PIC/shadow/IDT system fixture, not Linux boot\n'
