#!/bin/sh
# Build each test program as a static musl binary, translate it, run both,
# and require identical stdout and exit status.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
# The translator is sods' (its crate beside this unit); the kernel that runs what it makes is this one's.
sods=$(cd "$root/../sods" && pwd)
out="$here/out"
mkdir -p "$out"
cargo build -q --locked --release --manifest-path "$sods/Cargo.toml"
# The same translator as wasm (as the browser runs it); run.ts uses it when it is current.
cargo build -q --locked --release --target wasm32-unknown-unknown --lib --manifest-path "$sods/Cargo.toml"
status=0
for c in "$here"/*.c; do
  name=$(basename "$c" .c)
  # A test marked "xlat: stripped" is built as a distribution ships a program: no symbols, no relocations kept.
  if grep -q 'xlat: stripped' "$c"; then
    musl-gcc -static -O2 -pthread -s "$c" -o "$out/$name"
  else
    musl-gcc -static -O2 -pthread -Wl,--emit-relocs "$c" -o "$out/$name"
  fi
  "$sods/target/release/xlat" "$out/$name" "$out/$name.wasm" >/dev/null 2>&1
  set +e
  # A test marked "xlat: raw sockets" wants CAP_NET_RAW natively (the Prompt's root has it in its own network), one
  # marked "xlat: root" what root may do (every process translated is root): run as root, through sudo when it can be
  # had without a word, or not at all.
  if grep -q 'xlat: raw sockets\|xlat: root' "$c" && [ "$(id -u)" != 0 ]; then
    if sudo -n true 2>/dev/null; then sudo -n "$out/$name" a b > "$out/$name.native"; native=$?
    else echo "skip $name (it wants root natively)"; set -e; continue; fi
  else
    "$out/$name" a b > "$out/$name.native"; native=$?
  fi
  node "$root/runtime/run.ts" "$out/$name" a b > "$out/$name.xlat"; translated=$?
  set -e
  if [ "$native" = "$translated" ] && cmp -s "$out/$name.native" "$out/$name.xlat"; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $native vs $translated)"; status=1
  fi
done
# Functions cut into runs of a few blocks (kernel.rs RUN cuts only functions of thousands): every jump between runs a
# tail call to the run that holds its target, loops round them still taking their turns; the same output as native.
for name in calls switches signals threads jobs; do
  set +e
  XLAT_RUN=3 node "$root/runtime/run.ts" "$out/$name" a b > "$out/$name.cut"; cut=$?
  "$out/$name" a b > "$out/$name.native"; native=$?
  set -e
  if [ "$native" = "$cut" ] && cmp -s "$out/$name.native" "$out/$name.cut"; then
    echo "ok   $name (cut into runs of 3)"
  else
    echo "FAIL $name cut into runs of 3 (exit $native vs $cut)"; status=1
  fi
done
# Rust's std (what root3 is made of), when the musl target is installed.
if rustup target list --installed 2>/dev/null | grep -q x86_64-unknown-linux-musl; then
  for r in "$here"/*.rs; do
    name=rust-$(basename "$r" .rs)
    rustc -O --edition 2021 --target x86_64-unknown-linux-musl -C target-feature=+crt-static \
      -C relocation-model=static -C link-arg=-no-pie -C link-arg=-Wl,--emit-relocs "$r" -o "$out/$name"
    set +e
    "$out/$name" a b > "$out/$name.native"; native=$?
    node "$root/runtime/run.ts" "$out/$name" a b > "$out/$name.xlat"; translated=$?
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
# Go (threads: the runtime's own and goroutines over them), as git-lfs is built, where Go is installed.
if command -v go >/dev/null; then
  for g in "$here"/*.go; do
    name=go-$(basename "$g" .go)
    dir="$out/$name.src"; mkdir -p "$dir"; cp "$g" "$dir/main.go"; printf 'module t\ngo 1.21\n' > "$dir/go.mod"
    (cd "$dir" && CC=musl-gcc CGO_ENABLED=1 go build -ldflags '-linkmode=external -extldflags "-static -Wl,--emit-relocs"' -o "$out/$name" .)
    set +e
    "$out/$name" a b > "$out/$name.native"; native=$?
    node "$root/runtime/run.ts" "$out/$name" a b > "$out/$name.xlat"; translated=$?
    set -e
    if [ "$native" = "$translated" ] && cmp -s "$out/$name.native" "$out/$name.xlat"; then echo "ok   $name"; else echo "FAIL $name (exit $native vs $translated)"; status=1; fi
  done
fi
# The tree (src/tree.h), every name of a directory asked of it and of Linux.
if sh "$root/test/tree/tree.sh" > /dev/null 2>&1; then echo "ok   tree"; else echo "FAIL tree"; status=1; fi
# The kernel's tests.
for t in "$root"/test/runtime/*.test.ts; do
  if node --test "$t" >/dev/null 2>&1; then echo "ok   $(basename "$t")"; else echo "FAIL $(basename "$t")"; status=1; fi
done
exit $status
