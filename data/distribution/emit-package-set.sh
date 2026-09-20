#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if (( $# < 4 )); then
  printf 'usage: %s OUTPUT NAME IDENTITY PACKAGE:ROOT...\n' "$0" >&2
  exit 2
fi

output=$1
name=$2
identity=$3
shift 3

case $name:$identity in
  *[!a-zA-Z0-9._:-]*)
    printf 'invalid package-set name or identity: %s %s\n' \
      "$name" "$identity" >&2
    exit 2
    ;;
esac

mkdir -p "$output"
manifest=$output/$name-$identity.packages
partial=$manifest.partial.$$
rows=$manifest.rows.$$
cleanup() { rm -f -- "$partial" "$rows"; }
trap cleanup EXIT HUP INT TERM
: >"$rows"

for specification in "$@"; do
  package=${specification%%:*}
  root=${specification#*:}
  if [[ $package == "$specification" || \
        ! $package =~ ^[a-z0-9][a-z0-9+_.-]*$ || ! -d $root ]]; then
    printf 'invalid package root specification: %s\n' \
      "$specification" >&2
    exit 2
  fi
  root=$(realpath -e -- "$root")
  case $root in
    *$'\n'*|*$'\t'*)
      printf 'package root contains a forbidden delimiter: %q\n' "$root" >&2
      exit 2
      ;;
  esac
  if [[ -e $root/.complete ]]; then
    printf 'package payload contains a build marker: %s\n' "$root" >&2
    exit 1
  fi
  printf '%s\t%s\n' "$package" "$root" >>"$rows"
done

sort -t $'\t' -k1,1 -u "$rows" -o "$rows"
if [[ $(wc -l <"$rows") -ne $# ]]; then
  printf 'package-set contains a duplicate package name\n' >&2
  exit 1
fi
{
  printf 'package-root-set-v1\n'
  cat "$rows"
} >"$partial"
mv -- "$partial" "$manifest"
trap - EXIT HUP INT TERM
rm -f -- "$rows"
printf '%s\n' "$manifest"
