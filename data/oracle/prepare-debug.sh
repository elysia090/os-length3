#!/usr/bin/env bash
set -euo pipefail
test "$#" = 1 || { test "$#" = 2 && { test "$2" = --traps || test "$2" = --trap-faults; }; } || { printf 'usage: prepare-debug.sh NEW-DIRECTORY [--traps|--trap-faults]\n' >&2; exit 2; }
test ! -e "$1" || { printf 'output already exists\n' >&2; exit 2; }
mkdir -p "$1"
options=()
if [[ ${2:-} == --traps || ${2:-} == --trap-faults ]];then options+=(--defsym debug_trap_oracle=1);fi
if [[ ${2:-} == --trap-faults ]];then options+=(--defsym debug_trap_faults=1);fi
as --32 "${options[@]}" data/oracle/debug-entry.S -o "$1/entry.o"
ld -m elf_i386 -T data/oracle/exception-entry.ld "$1/entry.o" -o "$1/entry.elf"
