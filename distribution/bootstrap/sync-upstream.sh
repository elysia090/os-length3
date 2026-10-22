#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
destination=$here/../upstream
base=${QM_BUILD_INPUT_URL:-http://10.0.2.2:18081}
mkdir -p "$destination"
curl --fail --silent --show-error "$base/upstream-index" | \
while IFS= read -r name; do
  [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ && $name != *.part ]]
  if [[ ! -f $destination/$name ]]; then
    curl --fail --silent --show-error --retry 2 \
      --output "$destination/$name.part" "$base/upstream/$name"
    mv -- "$destination/$name.part" "$destination/$name"
  fi
done
# Individual builders verify each archive against sources.env before use.
printf 'upstream cache synchronized: %s\n' "$destination"
