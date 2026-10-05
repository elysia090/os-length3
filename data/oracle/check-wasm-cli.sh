#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then exit 2; fi
compiler=$(realpath -e -- "$1")
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
# SYSENTER remains outside the accepted 64-bit transfer profile. SYSCALL is
# now a compiled control boundary and cannot stand in for an unlowered opcode.
printf '\374\372\061\300\017\064' >"$scratch/page"
truncate -s 4096 "$scratch/page"
partial() {
  local status
  if "$compiler" "$@" >"$scratch/stdout" 2>"$scratch/stderr"; then status=0; else status=$?; fi
  test "$status" = 3
}
partial --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/cut"
grep -q '"modules":3,"instructions":3' "$scratch/cut.summary.json"
grep -q '"closed":false' "$scratch/cut.summary.json"
grep -q '"kind":"unlowered","entry":"4194308","linearContinuation":"4194308","status":-102' "$scratch/cut.summary.json"
test "$(od -An -tx1 -N8 "$scratch/cut.wasm" | tr -d ' \n')" = 0061736d01000000
for file in "$scratch/cut"*; do sha256sum -- "$file"; done >"$scratch/before"
if "$compiler" --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/cut"; then exit 1; fi
for file in "$scratch/cut"*; do sha256sum -- "$file"; done >"$scratch/after"
cmp "$scratch/before" "$scratch/after"

# Existing later output must survive rollback; only newly created files leave.
printf existing >"$scratch/collision.1.json"
if "$compiler" --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/collision"; then exit 1; fi
test "$(cat "$scratch/collision.1.json")" = existing
test ! -e "$scratch/collision.wasm"
test ! -e "$scratch/collision.json"
test ! -e "$scratch/collision.1.wasm"
test ! -e "$scratch/collision.summary.json"
for address in -1 +1 0x400001 18446744073709551616 0xfffffffffffff000; do
  if "$compiler" --code-pages "$address" 0x400000 "$scratch/page" "$scratch/bad"; then exit 1; fi
  test ! -e "$scratch/bad.summary.json"
done
truncate -s 4095 "$scratch/page"
if "$compiler" --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/bad"; then exit 1; fi
test ! -e "$scratch/bad.summary.json"

# A backward jump is compiled once, not followed as a guessed execution trace.
printf '\017\005' >"$scratch/page"
truncate -s 4096 "$scratch/page"
partial --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/syscall"
grep -q '"modules":1,"instructions":1' "$scratch/syscall.summary.json"
grep -q '"kind":"control"' "$scratch/syscall.summary.json"

printf '\353\376' >"$scratch/page"
truncate -s 4096 "$scratch/page"
partial --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/loop"
grep -q '"modules":1,"instructions":1' "$scratch/loop.summary.json"
grep -q '"kind":"control"' "$scratch/loop.summary.json"

head -c 4096 /dev/zero | tr '\000' '\220' >"$scratch/page"
partial --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/end"
grep -q '"modules":4,"instructions":4096' "$scratch/end.summary.json"
grep -q '"kind":"source-end","entry":"4198400"' "$scratch/end.summary.json"
head -c 4096 /dev/zero | tr '\000' '\372' >"$scratch/page"
partial --code-pages 0x400000 0x400000 "$scratch/page" "$scratch/budget"
grep -q '"modules":256,"instructions":256' "$scratch/budget.summary.json"
grep -q '"kind":"budget"' "$scratch/budget.summary.json"
printf 'Wasm CLI: green (emission, non-closure, invalid input, no-clobber/rollback, control/end/budget boundaries)\n'
