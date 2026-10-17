#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
mkdir -p "$temporary/source/console"
printf 'longrun\n' >"$temporary/source/console/type"
printf '#!/bin/sh\nexec /bin/sh -i\n' >"$temporary/source/console/run"
bash "$here/check-service-sources.sh" "$temporary/source" >/dev/null
printf '/bin/sh -i\n' >"$temporary/source/console/run"
if bash "$here/check-service-sources.sh" "$temporary/source" >/dev/null 2>&1; then
  echo 'source gate accepted a longrun with no interpreter' >&2
  exit 1
fi
printf '#!/bin/sh\nif then\n' >"$temporary/source/console/run"
if bash "$here/check-service-sources.sh" "$temporary/source" >/dev/null 2>&1; then
  echo 'source gate accepted invalid shell syntax' >&2
  exit 1
fi
bash "$here/check-service-sources.sh" "$here/services"
printf 'service source gate: green (direct-exec and syntax counterexamples)\n'
