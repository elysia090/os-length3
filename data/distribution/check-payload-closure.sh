#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 )); then
  printf 'usage: %s CATALOG PAYLOAD...\n' "$0" >&2
  exit 2
fi

catalog=$1
shift
if [[ ! -x $catalog ]]; then
  printf 'semantic catalog is not executable: %s\n' "$catalog" >&2
  exit 2
fi

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

is_linked_x86() {
  local path=$1 header
  header=$(LC_ALL=C readelf -h -- "$path" 2>/dev/null) || return 1
  grep -q 'Class:[[:space:]]*ELF64' <<<"$header" \
    && grep -q 'Machine:[[:space:]]*Advanced Micro Devices X86-64' \
      <<<"$header" \
    && grep -Eq 'Type:[[:space:]]*(EXEC|DYN)' <<<"$header"
}

declare -A seen=()
checked=0
failed=0
while IFS= read -r -d '' path; do
  is_linked_x86 "$path" || continue
  inode=$(stat -c '%d:%i' -- "$path")
  [[ -n ${seen[$inode]+present} ]] && continue
  seen[$inode]=1
  report="$temporary/$checked"
  if ! "$catalog" "$path" --require-semantics >"$report" 2>&1; then
    printf 'semantic closure: RED %s\n' "$path" >&2
    tail -n 32 -- "$report" >&2
    failed=$((failed + 1))
  fi
  checked=$((checked + 1))
done < <(find "$@" -type f -print0 | sort -z)

if (( failed )); then
  printf 'semantic payload closure: RED (%u unique ELF, %u failed)\n' \
    "$checked" "$failed" >&2
  exit 1
fi
printf 'semantic payload closure: green (%u unique ELF)\n' "$checked"
