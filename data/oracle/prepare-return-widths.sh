#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && ! -e $1 ]] || { printf 'usage: prepare-return-widths.sh NEW-DIRECTORY\n' >&2;exit 2; }
mkdir -p -- "$1"
for bytes in 2 4 8;do for far in 0 1;do for discard in 0 7;do
    [[ $far == 1 || $discard == 0 ]] || continue
    name="$1/return-$bytes-$far-$discard"
    as --32 --defsym RETURN_BYTES="$bytes" --defsym RETURN_FAR="$far" --defsym RETURN_DISCARD="$discard" \
        data/oracle/iret-entry.S -o "$name.o"
    ld -m elf_i386 -T data/oracle/exception-entry.ld "$name.o" -o "$name.elf"
done;done;done
