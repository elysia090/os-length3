#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

here=$(cd -- "$(dirname -- "$0")" && pwd)
. "$here/profile.env"

# This is the product package gate.  check-root.sh deliberately checks only an
# analysis population; it cannot promote a filesystem assembled by merging raw
# package roots.  This gate consumes the ordinary apk-installed state created by
# the signed repository transaction.

root=${1:?usage: check-package-state.sh ROOT}
if [[ ! -d $root ]]; then
  printf 'package candidate root does not exist: %s\n' "$root" >&2
  exit 2
fi
root=$(cd -- "$root" && pwd)

world=$root/etc/apk/world
installed=$root/lib/apk/db/installed
repositories=$root/etc/apk/repositories
keys=$root/etc/apk/keys
apk=$root/usr/bin/apk
failed=0

require_nonempty_file() {
  local description=$1 path=$2
  if [[ ! -s $path ]]; then
    printf '%s is absent or empty: /%s\n' \
      "$description" "${path#"$root"/}" >&2
    failed=1
  fi
}

require_nonempty_file 'exact apk world' "$world"
require_nonempty_file 'apk installed database' "$installed"
require_nonempty_file 'apk repository configuration' "$repositories"
if [[ ! -x $apk ]]; then
  printf 'in-root apk executable is absent: /usr/bin/apk\n' >&2
  failed=1
fi
public_key=$(find "$keys" -type f -size +0c -print -quit 2>/dev/null || true)
if [[ -z $public_key ]]; then
  printf 'apk package trust root is absent or empty: /etc/apk/keys\n' >&2
  failed=1
elif grep -q 'PRIVATE KEY' "$public_key"; then
  printf 'apk trust root contains private key material: %s\n' \
    "${public_key#"$root"}" >&2
  failed=1
fi

if [[ -s $world ]]; then
  world_rows=$(mktemp)
  trap 'rm -f -- "$world_rows" "${audit_rows:-}"' EXIT HUP INT TERM
  sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$world" \
    >"$world_rows"
  if [[ ! -s $world_rows ]] || \
     [[ $(wc -l <"$world_rows") != $(sort -u "$world_rows" | wc -l) ]]; then
    printf 'apk world constraints must be nonempty and unique\n' >&2
    failed=1
  fi
  while IFS= read -r constraint; do
    # The immutable release never asks the solver for a floating version.
    # Repository and index identity are fixed separately by the release root.
    if [[ ! $constraint =~ ^[a-zA-Z0-9][a-zA-Z0-9+_.-]*=[^=[:space:]]+$ ]]; then
      printf 'apk world constraint is not exact: %s\n' "$constraint" >&2
      failed=1
    fi
  done <"$world_rows"
fi

if [[ -s $repositories ]]; then
  repository_rows=$(mktemp)
  trap 'rm -f -- "${world_rows:-}" "${repository_rows:-}" "${audit_rows:-}"' \
    EXIT HUP INT TERM
  sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$repositories" \
    >"$repository_rows"
  if [[ ! -s $repository_rows ]]; then
    printf 'apk repository configuration contains no repository\n' >&2
    failed=1
  fi
fi

if (( failed != 0 )); then
  exit 1
fi

# --full reports both changes to owned paths and added/unowned paths.  One
# recursive audit replaces a path-at-a-time query loop; permissions and xattrs
# stay part of the installed-state proof.  apk's own database is transaction
# state and is excluded by apk's canonical full-audit policy.
audit_rows=$(mktemp)
if ! "$apk" --root "$root" --no-network audit --full --recursive \
    --check-permissions >"$audit_rows" 2>&1; then
  printf 'apk full audit failed\n' >&2
  sed -n '1,80p' "$audit_rows" >&2
  exit 1
fi

# The transaction files are deliberately not package-owned.  Their parent
# directories are therefore structural transaction coordinates as well. Apk's
# recursive audit reports the first unowned parent (normally `d lib/`) even
# though it suppresses its own database files. Derive the exact finite set of
# permitted directory rows from the declared transaction paths; do not admit a
# generic unowned-directory exception.
declare -A transaction_directory=()
for transaction_path in "${DISTRIBUTION_APK_TRANSACTION_PATHS[@]}"; do
  directory=$(dirname -- "$transaction_path")
  while [[ $directory != / && $directory != . ]]; do
    transaction_directory["${directory#/}/"]=1
    directory=$(dirname -- "$directory")
  done
done
unexpected_audit_rows=$(mktemp)
trap 'rm -f -- "${world_rows:-}" "${repository_rows:-}" "$audit_rows" "$unexpected_audit_rows"' \
  EXIT HUP INT TERM
while IFS= read -r audit_row; do
  audit_path=${audit_row#'d '}
  if [[ $audit_row == 'd '* &&
        -n ${transaction_directory["$audit_path"]+present} ]]; then
    continue
  fi
  printf '%s\n' "$audit_row" >>"$unexpected_audit_rows"
done <"$audit_rows"
if [[ -s $unexpected_audit_rows ]]; then
  printf 'apk ownership/content audit reported release drift:\n' >&2
  sed -n '1,80p' "$unexpected_audit_rows" >&2
  exit 1
fi

printf 'signed apk package state: green\n'
