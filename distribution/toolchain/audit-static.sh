#!/usr/bin/env bash
set -euo pipefail

stage=${1:?usage: audit-static.sh STAGE}
status=0
while IFS= read -r -d '' executable; do
  if readelf --file-header "$executable" >/dev/null 2>&1 && \
     readelf --program-headers "$executable" | grep 'interpreter' >/dev/null;
  then
    printf '%s\n' "${executable#"$stage"}"
    status=1
  fi
done < <(find "$stage/usr/bin" "$stage/usr/libexec" \
  -type f -perm /0111 -print0)
exit "$status"
