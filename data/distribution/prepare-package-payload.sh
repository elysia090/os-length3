#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# != 2 || ! -d $1 ]]; then
  printf 'usage: %s SOURCE-PACKAGE FRESH-PAYLOAD\n' "$0" >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
. "$here/profile.env"
source_root=$(realpath -e -- "$1")
parent=$(realpath -e -- "$(dirname -- "$2")")
name=$(basename -- "$2")
if [[ ! $name =~ ^[a-z0-9][a-z0-9+_.-]*$ ]]; then
  printf 'invalid package payload name: %s\n' "$name" >&2
  exit 2
fi
payload=$parent/$name
if [[ -e $payload || -L $payload || $payload == "$source_root" \
      || $payload == "$source_root"/* || $source_root == "$payload"/* ]]; then
  printf 'package payload must be fresh and disjoint: %s\n' "$payload" >&2
  exit 2
fi
if [[ $(stat -c %d -- "$source_root") != $(stat -c %d -- "$parent") ]]; then
  printf 'package payload requires one owner filesystem\n' >&2
  exit 2
fi

declare -A forbidden=()
for item in "${DISTRIBUTION_FORBIDDEN_NAMES[@]}"; do
  forbidden[$item]=1
done

mkdir -- "$payload"
cleanup() { rm -rf -- "$payload"; }
trap cleanup EXIT HUP INT TERM
# Component checkpoints own the bytes; this short-lived namespace selects
# the final signed package contents without copying or changing any ELF.
# An older checkpoint may contain optional commands from a broader profile.
# Removing names before mkpkg keeps signatures and the installed DB aligned;
# deleting them from the installed root would instead corrupt apk ownership.
cp -al -- "$source_root/." "$payload/"
if [[ $name == base-services ]]; then
  # The compatibility link belongs to this package and must resolve in the
  # installed root before Linux mounts its tmpfs. Include the empty mountpoint
  # in the signed payload, rather than adding it after the apk transaction.
  if [[ -L $payload/run || ( -e $payload/run && ! -d $payload/run ) ]]; then
    printf 'base-services run mountpoint is not a directory\n' >&2
    exit 1
  fi
  install -d -m 0755 "$payload/run"
fi
omitted=0
while IFS= read -r -d '' kind && IFS= read -r -d '' path; do
  case $kind in
    f|l)
      if [[ -n ${forbidden[${path##*/}]+present} ]]; then
        rm -f -- "$path"
        omitted=$((omitted + 1))
      fi
      ;;
  esac
done < <(find "$payload" -mindepth 1 -printf '%y\0%p\0')
trap - EXIT HUP INT TERM
printf 'package payload profile: %s (%s omitted coordinates)\n' "$name" "$omitted"
