#!/bin/sh
# A unit of the kernel/, built: one C file (taking lib's headers), no C library, linked as a static PIE that has nothing
# to relocate (everything it addresses it addresses from where it runs), so the kernel maps it and it runs: no loader,
# no start files, nothing done before its first instruction but what it does itself. Hardened as every program of the
# root is (the stack protector, stack clash protection, locals zeroed; full RELRO, no executable stack), and checked to
# be all of that.
#
#   sh kernel/lib/build.sh UNIT.c OUT
#
# CC (cc) builds it; CFLAGS are added after its own.
#
# Compiled, then linked with no C library: a distribution's GCC (Alpine's) turns the stack protector off for a unit
# compiled freestanding or told there is no C library (-ffreestanding, -nostdlib), whose __stack_chk_fail it takes to be
# missing. sys.h has its own, so a unit is compiled as any is, its own memcpy and the rest not taken for the library's
# (-fno-builtin), and told there is none only as it is linked.
set -eu
[ "$#" -eq 2 ] || { echo "usage: sh kernel/lib/build.sh UNIT.c OUT" >&2; exit 2; }
src=$1 out=$2
name=$(basename "$src" .c)
o=$(mktemp -d)
trap 'rm -rf "$o"' EXIT
"${CC:-cc}" -std=gnu17 -O2 -fno-builtin -fpie \
  -fstack-protector-strong -fstack-clash-protection -ftrivial-auto-var-init=zero \
  -mstack-protector-guard=global -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-tree-loop-distribute-patterns \
  -ffunction-sections -fdata-sections -Wall -Wextra ${CFLAGS:-} \
  -c -o "$o/$name.o" "$src"
"${CC:-cc}" -nostdlib -static-pie -Wl,-z,relro,-z,now,-z,noexecstack,--gc-sections,--build-id=none -o "$out" "$o/$name.o"
bad() { echo "$name: $*" >&2; exit 1; }
d=$(objdump -d "$out")
echo "$d" | grep -q 'call.*<__stack_chk_fail>' || bad "no stack protector"
# (A function given its own target, as target("avx2"), is compiled with the stack protector's guard read from a thread's
# storage, -mstack-protector-guard=global forgotten: there is no such storage, the first read faults.)
! echo "$d" | grep -q '%fs:' || bad "a read of a thread's storage (an array in a function of its own target?): $(echo "$d" | grep -B30 '%fs:' | grep '>:$' | tail -1)"
h=$(readelf -hlrdsW "$out")
echo "$h" | grep -q 'Type: *DYN' || bad "not position-independent"
echo "$h" | grep -q 'There are no relocations in this file' || bad "something to relocate"
! echo "$h" | grep -q 'INTERP' || bad "asks for a loader"
! echo "$h" | grep -q '(NEEDED)' || bad "needs a library"
echo "$h" | grep -q GNU_RELRO && echo "$h" | grep -qE 'BIND_NOW|FLAGS_1.*NOW' || bad "not full RELRO"
! echo "$h" | grep -A1 GNU_STACK | grep -q RWE || bad "an executable stack"
! echo "$h" | awk '$7 == "UND" && $8 != ""' | grep -q . || bad "something left undefined: $(echo "$h" | awk '$7 == "UND" && $8 != "" {print $8}')"
