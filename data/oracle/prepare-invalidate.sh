#!/usr/bin/env bash
# Oracle only: use already-emitted exact source pages, not a second decoder.
set -euo pipefail
test "$#" = 1 || { printf 'usage: prepare-invalidate.sh FIXTURE-DIRECTORY\n' >&2; exit 2; }
test ! -e "$1/system.elf" && test ! -e "$1/privilege"
as --32 -I "$1" data/oracle/invalidate-system.S -o "$1/system.o"
ld -m elf_i386 -T data/oracle/exception-entry.ld "$1/system.o" -o "$1/system.elf"
cc -O2 -std=c11 -Wall -Wextra -Wpedantic -Wconversion -Wshadow -fPIE -pie \
    data/oracle/invalidate-privilege.c -o "$1/privilege"
"$1/privilege" "$1"
