#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! -x $1 || ! -f $2 ]]; then
  printf 'usage: %s WASM-COMPILER OPTIMIZED-ELF\n' "$0" >&2
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
# A header is not execution proof. The backend's machine-ABI oracle must be
# connected before this gate can succeed; never silently mark a stub green.
printf 'executable Wasm projection: red (machine-ABI execution oracle pending)\n' >&2
exit 1
