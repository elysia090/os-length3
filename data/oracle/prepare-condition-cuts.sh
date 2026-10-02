#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && ! -e $1 ]] || { printf 'usage: %s NEW-OUTPUT-DIRECTORY\n' "$0" >&2; exit 2; }
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p -- "$1"
output=$(cd -- "$1" && pwd)
emit() {
  local name=$1
  shift
  "${CC:-cc}" -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs "$@" \
    "$repo/src/v2/wasm-compiler/check/condition-fixture.S" -o "$output/$name.linked.elf"
  "$repo/src/v2/postlink-compiler/build/postlink-compiler" \
    "$output/$name.linked.elf" -o "$output/$name.optimized.elf"
  "$repo/src/v2/optimized-x86/build/postlink-verify" \
    "$output/$name.linked.elf" "$output/$name.optimized.elf"
  "$repo/src/v2/wasm-compiler/build/cut-check" "$output/$name.optimized.elf" "$output/$name"
}
for opcode in seto setno setb setae sete setne setbe seta sets setns setp setnp setl setge setle setg; do
  for row in al:rax ah:rax cl:rcx ch:rcx r9b:r9 dil:rdi; do
    reg=${row%%:*}; parent=${row#*:}
    for seeded in 0 1; do
      args=(-DCONDITION_OPCODE="$opcode" -DCONDITION_REGISTER="$reg" -DCONDITION_PARENT="$parent")
      if [[ $seeded == 1 ]]; then args+=(-DCONDITION_SEED=1); fi
      emit "$opcode-$reg-$seeded" "${args[@]}"
    done
  done
done
for rank in {1..6}; do emit "compose-$rank" -DCONDITION_CASE="$rank"; done
printf 'Native condition records prepared; execute direct Wasm and C table comparisons.\n'
