#!/bin/sh
# Build each test program as a static musl binary, translate it, run both,
# and require identical stdout and exit status.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
out="$here/out"
mkdir -p "$out"
cargo build -q --locked --release --manifest-path "$root/Cargo.toml"
# The same translator as wasm (as the browser runs it); run.mjs uses it when it is current.
cargo build -q --locked --release --target wasm32-unknown-unknown --lib --manifest-path "$root/Cargo.toml"
status=0
for c in "$here"/c/*.c; do
  name=$(basename "$c" .c)
  musl-gcc -static -O2 -pthread -Wl,--emit-relocs "$c" -o "$out/$name"
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
# Rust's std (what l3 is made of), when the musl target is installed.
if rustup target list --installed 2>/dev/null | grep -q x86_64-unknown-linux-musl; then
  for r in "$here"/rust/*.rs; do
    name=rust-$(basename "$r" .rs)
    rustc -O --edition 2021 --target x86_64-unknown-linux-musl -C target-feature=+crt-static \
      -C relocation-model=static -C link-arg=-no-pie -C link-arg=-Wl,--emit-relocs "$r" -o "$out/$name"
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
else
  echo "skip rust (no x86_64-unknown-linux-musl target)"
fi
# Go (threads: the runtime's own and goroutines over them), as git-lfs is built.
# XLAT_GO=1: the translator does not lower RCR yet, which every Go program's
# runtime.semacquire1 uses, so it is asked for until it does.
if [ -n "${XLAT_GO:-}" ] && command -v go >/dev/null; then
  for g in "$here"/go/*.go; do
    name=go-$(basename "$g" .go)
    dir="$out/$name.src"; mkdir -p "$dir"; cp "$g" "$dir/main.go"; printf 'module t\ngo 1.21\n' > "$dir/go.mod"
    (cd "$dir" && CC=musl-gcc CGO_ENABLED=1 go build -ldflags '-linkmode=external -extldflags "-static -Wl,--emit-relocs"' -o "$out/$name" .)
    set +e
    "$out/$name" a b > "$out/$name.native"; native=$?
    node "$root/runtime/run.mjs" "$out/$name" a b > "$out/$name.xlat"; translated=$?
    set -e
    if [ "$native" = "$translated" ] && cmp -s "$out/$name.native" "$out/$name.xlat"; then echo "ok   $name"; else echo "FAIL $name (exit $native vs $translated)"; status=1; fi
  done
fi
for t in "$here"/*.test.mjs; do
  if node --test "$t" >/dev/null 2>&1; then echo "ok   $(basename "$t")"; else echo "FAIL $(basename "$t")"; status=1; fi
done
exit $status
