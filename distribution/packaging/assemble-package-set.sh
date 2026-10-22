#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
if [[ $# != 2 ]]; then
  printf 'usage: %s PACKAGE-SET OUTPUT-ROOT\n' "$0" >&2; exit 2
fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
. "$here/package-set-content.sh"
manifest=$(realpath -e -- "$1")
output=$(realpath -m -- "$2"); parent=$(dirname -- "$output"); marker=$output.package-set
package_content_read "$manifest"
for root in "${package_content_roots[@]}"; do
  [[ $parent != "$root" && $parent != "$root"/* ]] || exit 2
done
mkdir -p "$parent"; parent=$(realpath -e -- "$parent")
stage=$(mktemp -d -- "$parent/.package-set-assembly.XXXXXXXX")
cleanup() {
  [[ -d $stage && $(dirname -- "$(realpath -e -- "$stage")") == "$parent" && $stage == "$parent"/.package-set-assembly.* ]] || return
  rm -rf -- "$stage"
}
trap cleanup EXIT HUP INT TERM
# Capture the metadata pair too. Parsing and hashing the same private bytes
# prevents a replaced manifest from supplying different roots and bindings.
cp -- "$manifest" "$stage/manifest"
cp -- "$manifest.content" "$stage/manifest.content"
package_content_read "$stage/manifest"
for root in "${package_content_roots[@]}"; do
  [[ $parent != "$root" && $parent != "$root"/* ]] || exit 2
done
mkdir "$stage/inputs"
for i in "${!package_content_names[@]}"; do
  snapshot=$stage/inputs/${package_content_names[i]}
  package_content_snapshot "${package_content_roots[i]}" "$snapshot"
  actual=$(package_content_identity "$snapshot")
  if [[ $actual != "${package_content_hashes[i]}" ]]; then
    printf 'package-set input content changed: %s\n' "${package_content_names[i]}" >&2; exit 1
  fi
done
# Assembly consumes only these independent input cuts from this point on.
[[ $(sha256sum "$manifest" | cut -d' ' -f1) == "$package_content_manifest_sha" && $(sha256sum "$manifest.content" | cut -d' ' -f1) == "$package_content_sha" ]] || exit 1
if [[ -e $output || -L $output || -e $marker || -L $marker ]]; then
  [[ -d $output && ! -L $output && -f $marker && ! -L $marker ]] || exit 1
  mapfile -t record <"$marker"
  if [[ ${#record[@]} -ne 4 || ${record[0]} != package-set-assembly-v2 || ${record[1]} != "$package_content_manifest_sha" || ${record[2]} != "$package_content_sha" || ! ${record[3]} =~ ^[0-9a-f]{64}$ ]]; then
    printf 'existing assembly is legacy or mismatched; retained: %s\n' "$output" >&2; exit 1
  fi
  [[ $(package_content_identity "$output") == "${record[3]}" ]] || { printf 'existing assembly content changed; retained: %s\n' "$output" >&2; exit 1; }
else
  mkdir "$stage/root"
  for name in "${package_content_names[@]}"; do
    bash "$here/clone-tree.sh" "$stage/inputs/$name" "$stage/root"
  done
  root_identity=$(package_content_identity "$stage/root")
  printf 'package-set-assembly-v2\n%s\n%s\n%s\n' "$package_content_manifest_sha" "$package_content_sha" "$root_identity" >"$stage/marker"
  # Later-package links refer only to private copies, so callers cannot
  # modify this output by writing the original package roots afterwards.
  mv -T -n -- "$stage/root" "$output"
  [[ ! -e $stage/root ]] || exit 1
  ln -- "$stage/marker" "$marker"
fi
printf '%s\n' "$output"
