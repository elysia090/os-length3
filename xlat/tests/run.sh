#!/bin/sh
# Build each test program as a static musl binary, translate it, run both,
# and require identical stdout and exit status.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
out="$here/out"
mkdir -p "$out"
cargo build -q --release --manifest-path "$root/Cargo.toml"
status=0
for c in "$here"/c/*.c; do
  name=$(basename "$c" .c)
  musl-gcc -static -O2 -Wl,--emit-relocs "$c" -o "$out/$name"
  "$root/target/release/xlat" "$out/$name" "$out/$name.wasm" >/dev/null 2>&1
  set +e
  "$out/$name" a b > "$out/$name.native"; native=$?
  node "$root/runtime/run.mjs" "$out/$name" a b > "$out/$name.xlat"; translated=$?
  set -e
  if [ "$native" = "$translated" ] && cmp -s "$out/$name.native" "$out/$name.xlat"; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $native vs $translated)"; status=1
  fi
done
exit $status
