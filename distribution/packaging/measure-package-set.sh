#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

manifest=${1:?usage: measure-package-set.sh PACKAGE-SET}
if [[ ! -f $manifest ]] || \
   [[ $(head -n 1 -- "$manifest") != package-root-set-v1 ]]; then
  printf 'unknown or absent package-set: %s\n' "$manifest" >&2
  exit 2
fi

printf 'package\tnondirectory_entries\tpayload_bytes\n'
tail -n +2 -- "$manifest" |
while IFS=$'\t' read -r name root extra; do
  if [[ -n $extra || ! -d $root ]]; then
    printf 'invalid package-set row: %s %s\n' "$name" "$root" >&2
    exit 1
  fi
  find "$root" -mindepth 1 ! -type d -printf '%s\n' |
    awk -v name="$name" '
      { entries += 1; bytes += $1 }
      END { printf "%s\t%d\t%d\n", name, entries, bytes }
    '
done
