#!/bin/sh
# prompt on this Linux: the same Rust prompt that stands at a terminal's other end on Linux, translated, in front
# of a terminal this kernel makes and given another (linux/pty.ts), its signals read as a file (signalfd), by
# prompt's own check of it (../../../prompt/test/attach.c), which is the same program on both.
#
#   sh module/sods/test/prompt/run.sh
#
# Both are built static (prompt for x86_64-unknown-linux-musl, the check with musl-gcc), their relocations kept, as
# sods takes a program; then the check is run in a root that holds the two and nothing else.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sods=$(cd "$here/../.." && pwd)
prompt=$(cd "$sods/../prompt" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
RUSTFLAGS="-C target-feature=+crt-static -C relocation-model=static -C link-arg=-no-pie -C link-arg=-Wl,--emit-relocs" \
  cargo build -q --locked --release --target x86_64-unknown-linux-musl --manifest-path "$prompt/Cargo.toml"
cp "$prompt/target/x86_64-unknown-linux-musl/release/prompt" "$root/prompt"
musl-gcc -static -O2 -pthread -Wall -Wextra -Wl,--emit-relocs "$prompt/test/attach.c" -o "$root/attach"
cargo build -q --locked --release --manifest-path "$sods/Cargo.toml"
cargo build -q --locked --release --target wasm32-unknown-unknown --lib --manifest-path "$sods/Cargo.toml"
if node "$sods/runtime/run.ts" --root "$root" --cwd / /attach /prompt < /dev/null; then echo "ok   prompt on sods"
else echo "FAIL prompt on sods"; exit 1; fi
