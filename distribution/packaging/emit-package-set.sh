#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
if (( $# < 4 )); then
  printf 'usage: %s OUTPUT NAME IDENTITY PACKAGE:ROOT...\n' "$0" >&2; exit 2
fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
. "$here/package-set-content.sh"
output=$(realpath -m -- "$1"); name=$2; identity=$3; shift 3
case $name:$identity in *[!a-zA-Z0-9._:-]*) exit 2 ;; esac
specifications=("$@")
for specification in "${specifications[@]}"; do
  package=${specification%%:*}; root=${specification#*:}
  [[ $package != "$specification" && $package =~ ^[a-z0-9][a-z0-9+_.-]*$ && -d $root ]] || exit 2
  root=$(realpath -e -- "$root")
  case $root in *$'\n'*|*$'\t'*) exit 2 ;; esac
  [[ $output != "$root" && $output != "$root"/* ]] || exit 2
done
mkdir -p "$output"; output=$(realpath -e -- "$output")
manifest=$output/$name-$identity.packages
stage=$(mktemp -d -- "$output/.package-set-capture.XXXXXXXX")
cleanup() {
  [[ -d $stage && $(dirname -- "$(realpath -e -- "$stage")") == "$output" && $stage == "$output"/.package-set-capture.* ]] || return
  rm -rf -- "$stage"
}
trap cleanup EXIT HUP INT TERM
: >"$stage/rows"; : >"$stage/content"
for specification in "${specifications[@]}"; do
  package=${specification%%:*}; root=$(realpath -e -- "${specification#*:}")
  [[ ! -e $root/.complete && ! -L $root/.complete ]] || exit 1
  package_content_snapshot "$root" "$stage/$package"
  digest=$(package_content_identity "$stage/$package")
  printf '%s\t%s\n' "$package" "$root" >>"$stage/rows"
  printf '%s\t%s\n' "$package" "$digest" >>"$stage/content"
done
sort -t $'\t' -k1,1 -u "$stage/rows" -o "$stage/rows"
[[ $(wc -l <"$stage/rows") -eq ${#specifications[@]} ]] || exit 1
sort -t $'\t' -k1,1 "$stage/content" -o "$stage/content"
{ printf 'package-root-set-v1\n'; cat "$stage/rows"; } >"$stage/manifest"
{ printf 'package-root-content-v1\n'; sha256sum "$stage/manifest" | cut -d' ' -f1; cat "$stage/content"; } >"$stage/binding"
if [[ -e $manifest || -L $manifest || -e $manifest.content || -L $manifest.content ]]; then
  if [[ ! -f $manifest || ! -f $manifest.content ]] || ! cmp -s -- "$stage/manifest" "$manifest" || ! cmp -s -- "$stage/binding" "$manifest.content"; then
    printf 'existing package-set differs or has no binding; retained: %s\n' "$manifest" >&2; exit 1
  fi
else
  # A crash between the two no-clobber links leaves an incomplete pair;
  # subsequent calls reject it instead of silently repairing it.
  ln -- "$stage/manifest" "$manifest"
  ln -- "$stage/binding" "$manifest.content"
fi
printf '%s\n' "$manifest"
