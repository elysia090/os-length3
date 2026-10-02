#!/bin/sh
# Check the actual configured kernel, not a guessed architecture baseline.
set -eu
if [ "$#" -ne 2 ]; then
    echo "usage: check-kernel-profile.sh KBUILD KERNEL-PROFILE-CHECK" >&2
    exit 2
fi
header=$1/arch/x86/include/generated/asm/cpufeaturemasks.h
test -r "$header"
set -- "$2"
for word in 0 1 4 6 16; do
    mask=$(awk -v key="REQUIRED_MASK$word" '$1 == "#define" && $2 == key { sub(/U$/, "", $3); print $3 }' "$header")
    case "$mask" in
        0x????????) set -- "$@" "$mask" ;;
        *) echo "invalid/missing required CPU word $word" >&2; exit 2 ;;
    esac
done
"$@"
