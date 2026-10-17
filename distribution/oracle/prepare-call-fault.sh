#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?usage: prepare-call-fault.sh NEW-OUTPUT-DIRECTORY}
test ! -e "$output" || { printf 'Refusing existing output\n' >&2; exit 2; }
mkdir -p -- "$output/root"
# Keep the observer's text away from the exact tested source coordinate.
cc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror -static -no-pie \
  -Wl,-Ttext-segment=0x800000 "$repo/distribution/oracle/call-fault-observe.c" \
  "$repo/distribution/oracle/call-fault-observe.S" -o "$output/root/init"
(cd -- "$output/root"; printf 'init\n' | cpio --quiet -o -H newc | gzip -n -9) > "$output/observer.cpio.gz"
