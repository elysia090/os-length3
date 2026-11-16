#!/bin/sh
# A unit of C, built: one C file (taking lib's headers), no C library, linked as a static PIE that has nothing
# to relocate (everything it addresses it addresses from where it runs), so the kernel maps it and it runs: no loader,
# no start files, nothing done before its first instruction but what it does itself. Hardened as every program of the
# root is (the stack protector, stack clash protection, locals zeroed; full RELRO, no executable stack), and checked to
# be all of that.
#
#   sh lib/build.sh UNIT.c OUT
#
# CC (cc) builds it; CFLAGS are added after its own.
#
# Compiled, then linked with no C library: a distribution's GCC (Alpine's) turns the stack protector off for a unit
# compiled freestanding or told there is no C library (-ffreestanding, -nostdlib), whose __stack_chk_fail it takes to be
# missing. sys.h has its own, so a unit is compiled as any is, its own memcpy and the rest not taken for the library's
# (-fno-builtin), and told there is none only as it is linked.
set -eu
[ "$#" -eq 2 ] || { echo "usage: sh lib/build.sh UNIT.c OUT" >&2; exit 2; }
src=$1 out=$2
name=$(basename "$src" .c)
o=$(mktemp -d)
trap 'rm -rf "$o"' EXIT
"${CC:-cc}" -std=gnu17 -O2 -fno-builtin -fpie \
  -fstack-protector-strong -fstack-clash-protection -ftrivial-auto-var-init=zero \
  -mstack-protector-guard=global -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-tree-loop-distribute-patterns \
  -ffunction-sections -fdata-sections -Wall -Wextra -Werror ${CFLAGS:-} \
  -c -o "$o/$name.o" "$src"
"${CC:-cc}" -nostdlib -static-pie -Wl,-z,relro,-z,now,-z,noexecstack,--gc-sections,--build-id=none -o "$out" "$o/$name.o"
bad() { echo "$name: $*" >&2; exit 1; }
objdump -d "$out" > "$o/disassembly"
grep -q 'call.*<__stack_chk_fail>' "$o/disassembly" || bad "no stack protector"
! grep -q '%fs:' "$o/disassembly" || bad "a read of thread-local storage"
readelf -hlrdsW "$out" > "$o/headers"
grep -q 'Type: *DYN' "$o/headers" || bad "not position-independent"
grep -q 'There are no relocations in this file' "$o/headers" || bad "something to relocate"
! grep -q 'INTERP' "$o/headers" || bad "asks for a loader"
! grep -q '(NEEDED)' "$o/headers" || bad "needs a library"
grep -q GNU_RELRO "$o/headers" && grep -qE 'BIND_NOW|FLAGS_1.*NOW' "$o/headers" || bad "not full RELRO"
! grep -A1 GNU_STACK "$o/headers" | grep -q RWE || bad "an executable stack"
awk '$7 == "UND" && $8 != "" {print $8}' "$o/headers" > "$o/undefined"
[ ! -s "$o/undefined" ] || bad "something left undefined"
