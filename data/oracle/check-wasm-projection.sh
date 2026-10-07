#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 5 || ! -x $1 || ! -f $2 || ! -f $3 || ! -f $4 || ! -f $5 ]]; then
  printf 'usage: %s WASM-COMPILER OPTIMIZED-ELF VM.WASM COLD-COMPILER.WASM FROZEN-COMPILER.WASM\n' "$0" >&2
  exit 2
fi
compiler=$(realpath -e -- "$1")
input=$(realpath -e -- "$2")
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
printf 'source-optimized-elf: '
sha256sum -- "$input"
if ! "$compiler" "$input" "$scratch/output.wasm"; then
  printf 'executable Wasm projection: red (compiler did not emit)\n' >&2
  exit 1
fi
if [[ ! -s $scratch/output.wasm \
      || $(od -An -N8 -tx1 "$scratch/output.wasm" | tr -d ' \n') \
         != 0061736d01000000 ]]; then
  printf 'executable Wasm projection: red (missing/invalid module header)\n' >&2
  exit 1
fi
# Compare every final PF_X coordinate, biases and permission/fault contexts
# through the actual C VM, not just the file magic or one entry prefix. This
# oracle explicitly refuses images outside its one-page test environment;
# it is not a Linux/signed-production/root publication acceptance gate.
node "$(dirname -- "$0")/check-image-dispatch.mjs" "$3" "$4" "$5" "$input" "$scratch/output.wasm"
