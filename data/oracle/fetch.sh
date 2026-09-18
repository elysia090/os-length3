#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
. "$here/sources.env"

upstream="$data/upstream"
mkdir -p "$upstream"

fetch() {
  local url=$1 output=$2 expected=$3
  if [[ ! -f $output ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$output.part" "$url"
    mv "$output.part" "$output"
  fi
  printf '%s  %s\n' "$expected" "$output" |
    sha256sum --check --status
}

fetch "$QEMU_ORACLE_URL" \
  "$upstream/qemu-$QEMU_ORACLE_VERSION.tar.xz" \
  "$QEMU_ORACLE_SHA256"
fetch "$REMILL_ORACLE_URL" \
  "$upstream/remill-$REMILL_ORACLE_COMMIT.tar.gz" \
  "$REMILL_ORACLE_SHA256"
fetch "$XED_ORACLE_URL" \
  "$upstream/xed-v$XED_ORACLE_VERSION.tar.gz" \
  "$XED_ORACLE_SHA256"
fetch "$SOFTFLOAT_ORACLE_URL" \
  "$upstream/berkeley-softfloat-$SOFTFLOAT_ORACLE_COMMIT.tar.gz" \
  "$SOFTFLOAT_ORACLE_SHA256"

printf 'verified QEMU %s, Remill %s, Intel XED %s and SoftFloat %s\n' \
  "$QEMU_ORACLE_VERSION" "$REMILL_ORACLE_COMMIT" "$XED_ORACLE_VERSION" \
  "$SOFTFLOAT_ORACLE_COMMIT"
