#!/usr/bin/env bash
set -euo pipefail

if [[ ( $# != 4 && $# != 5 ) || ! -f $1 || ! -f $2 || ! -x $3 || ! -f $4 ]]; then
  printf 'usage: %s BUNDLE.tar.zst RELEASE-INPUTS POSTLINK-VERIFY ZLIB-SOURCE [RECEIPT]\n' "$0" >&2
  exit 2
fi

here=$(cd -- "$(dirname -- "$0")" && pwd)
# Every check consumes private copies of the exact archive, inputs, verifier,
# upstream source and policy. A receipt binds that cut; it grants no publisher
# authority or source/binary provenance. No diagnostic overrides are accepted.
exec python3 "$here/native-bundle-acceptance.py" check "$@"
