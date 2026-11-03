#!/bin/sh
# you, built: one unit, no C library, linked as a static PIE that has nothing to relocate (everything it addresses it
# addresses from where it runs), so the kernel maps it and it runs: no loader, no start files, nothing done before its
# first instruction but what it does itself. Hardened as every program of the root is (the stack protector, stack clash
# protection, locals zeroed; full RELRO, no executable stack), and checked to be all of that.
#
#   sh build.sh [OUT]          OUT: where the program goes (./you beside this)
#
# CC (cc) builds it; CFLAGS are added after its own.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/you}
"${CC:-cc}" -std=gnu17 -O2 -ffreestanding -nostdlib -static-pie -fpie \
  -fstack-protector-strong -fstack-clash-protection -ftrivial-auto-var-init=zero \
  -mstack-protector-guard=global -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-tree-loop-distribute-patterns \
  -ffunction-sections -fdata-sections -Wall -Wextra ${CFLAGS:-} \
  -Wl,-z,relro,-z,now,-z,noexecstack,--gc-sections,--build-id=none \
  -o "$out" "$here/you.c"
bad() { echo "you: $*" >&2; exit 1; }
h=$(readelf -hlrdsW "$out")
echo "$h" | grep -q 'Type: *DYN' || bad "not position-independent"
echo "$h" | grep -q 'There are no relocations in this file' || bad "something to relocate"
! echo "$h" | grep -q 'INTERP' || bad "asks for a loader"
! echo "$h" | grep -q '(NEEDED)' || bad "needs a library"
echo "$h" | grep -q GNU_RELRO && echo "$h" | grep -qE 'BIND_NOW|FLAGS_1.*NOW' || bad "not full RELRO"
! echo "$h" | grep -A1 GNU_STACK | grep -q RWE || bad "an executable stack"
! echo "$h" | awk '$7 == "UND" && $8 != ""' | grep -q . || bad "something left undefined: $(echo "$h" | awk '$7 == "UND" && $8 != "" {print $8}')"
