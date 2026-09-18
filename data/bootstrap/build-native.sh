#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$here/../.." && pwd)
. "$here/environment.sh"
printf 'bootstrap-id=%s\n' "$QM_BOOTSTRAP_ID"
make -s -C "$repo/src/v2" -j"${QM_JOBS:-4}" all
make -s -C "$repo/src/v2/postlink-compiler" -j"${QM_JOBS:-4}" \
  select-x86-check shift-width-check condition-code-check arithmetic-cut-check \
  compare-cut-check carry-cut-check extension-cut-check \
  normal-form-check physical-check \
  quotient-check instruction-law-check
