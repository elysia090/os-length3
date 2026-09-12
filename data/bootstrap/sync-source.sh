#!/usr/bin/env bash
set -euo pipefail

# Run inside the build host. Source replacement preserves every ignored build,
# source-archive cache and product checkpoint; stale source files are removed.
base=${QM_BUILD_INPUT_URL:-http://10.0.2.2:18081}
destination=/build/source
stage=$(mktemp -d /build/source-sync.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
curl --fail --silent --show-error "$base/source.tar" | tar -xf - -C "$stage"
test -f "$stage/data/bootstrap/environment.sh"
test -f "$stage/src/v2/postlink-compiler/Makefile"
# Windows tar cannot represent the Git executable bit. These are the executable
# shell entry points; apply that metadata before importing into the Linux tree.
find "$stage" -type f -name '*.sh' -exec chmod 0755 {} +
mkdir -p "$destination"
rsync -a --delete --exclude=build --exclude='build-*/' --exclude=temp \
  --exclude=upstream --exclude=.git "$stage/" "$destination/"
printf 'source synchronized: %s\n' "$destination"
