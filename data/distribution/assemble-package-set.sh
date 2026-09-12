#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# != 2 ]]; then
  printf 'usage: %s PACKAGE-SET OUTPUT-ROOT\n' "$0" >&2
  exit 2
fi

manifest=$(realpath -e -- "$1")
output=$2
identity=$(sha256sum "$manifest" | cut -d' ' -f1)
marker=$output.package-set
if [[ -d $output && -f $marker ]] && [[ $(<"$marker") == "$identity" ]]; then
  printf '%s\n' "$output"
  exit 0
fi
if [[ -e $output || -e $marker ]]; then
  printf 'incomplete or mismatched package-set assembly: %s\n' \
    "$output" >&2
  exit 1
fi

if [[ $(head -n 1 -- "$manifest") != package-root-set-v1 ]]; then
  printf 'unknown package-set schema: %s\n' "$manifest" >&2
  exit 2
fi

parent=$(dirname -- "$output")
name=$(basename -- "$output")
mkdir -p "$parent"
partial=$parent/.$name.partial.$$
rows=$parent/.$name.rows.$$
cleanup() { rm -rf -- "$partial"; rm -f -- "$rows"; }
trap cleanup EXIT HUP INT TERM
tail -n +2 -- "$manifest" >"$rows"
if [[ ! -s $rows ]] || ! sort -t $'\t' -k1,1 -c -u "$rows"; then
  printf 'package-set rows must be nonempty, sorted and unique\n' >&2
  exit 1
fi
mkdir -p "$partial"
while IFS=$'\t' read -r package root extra; do
  if [[ -n $extra || ! $package =~ ^[a-z0-9][a-z0-9+_.-]*$ || \
        ! -d $root || -e $root/.complete ]]; then
    printf 'invalid package-set row: %s %s\n' "$package" "$root" >&2
    exit 1
  fi
  bash "$(dirname -- "$0")/clone-tree.sh" "$root" "$partial"
done <"$rows"
mv -- "$partial" "$output"
printf '%s\n' "$identity" >"$marker.tmp"
mv -- "$marker.tmp" "$marker"
trap - EXIT HUP INT TERM
rm -f -- "$rows"
printf '%s\n' "$output"
