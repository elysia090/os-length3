#!/usr/bin/env bash
set -euo pipefail

# Populate distribution/upstream/ with every archive pinned by distribution/sources.env.
#
# This is the host-side companion to distribution/bootstrap/sync-upstream.sh: the build
# host serves this directory over HTTP, so the guest never needs to reach
# upstream itself.  Individual builders still verify each archive against
# sources.env before use; this script only guarantees the cache is complete and
# digest-correct on the host.

here=$(cd -- "$(dirname -- "$0")" && pwd)
upstream=$here/upstream
mkdir -p "$upstream"
. "$here/sources.env"

fetched=0
verified=0
failed=0

verify() {
  local expected=$1 algorithm=$2 target=$3
  printf '%s  %s\n' "$expected" "$target" | "${algorithm}sum" --check --status
}

while IFS= read -r line; do
  case $line in
    *_URL=*) ;;
    *) continue ;;
  esac
  key=${line%%=*}
  url=${line#*=}
  name=${key%_URL}
  expected=$(eval "printf '%s' \"\${${name}_SHA256:-}\"")
  algorithm=sha256
  if [[ -z $expected ]]; then
    expected=$(eval "printf '%s' \"\${${name}_SHA512:-}\"")
    algorithm=sha512
  fi
  if [[ -z $expected ]]; then
    printf 'skip %s: no pinned digest\n' "$key" >&2
    continue
  fi
  base=${url##*/}
  target=$upstream/$base
  if [[ -f $target ]] && verify "$expected" "$algorithm" "$target"; then
    verified=$((verified + 1))
    continue
  fi
  printf 'fetch %s\n' "$base"
  if ! curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      --output "$target.part" "$url"; then
    printf 'FAIL %s: download\n' "$base" >&2
    rm -f -- "$target.part"
    failed=$((failed + 1))
    continue
  fi
  if ! verify "$expected" "$algorithm" "$target.part"; then
    printf 'FAIL %s: digest mismatch\n' "$base" >&2
    rm -f -- "$target.part"
    failed=$((failed + 1))
    continue
  fi
  mv -- "$target.part" "$target"
  fetched=$((fetched + 1))
done < "$here/sources.env"

printf 'upstream cache: %s fetched, %s already verified, %s failed\n' \
  "$fetched" "$verified" "$failed"
[[ $failed == 0 ]]
