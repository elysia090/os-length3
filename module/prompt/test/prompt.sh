#!/bin/sh
# The terminal endpoint alone: no muk, OCI, namespaces or box startup are needed. prompt is put in front of one
# real terminal and given another, by attach.c, which is the same program where the terminals are sods' Linux's
# (../../sods/test/prompt/run.sh).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cargo build --locked --release --manifest-path "$here/../Cargo.toml"
cp "$here/../target/release/prompt" "$t/prompt"
${CC:-cc} -O2 -pthread -Wall -Wextra "$here/attach.c" -o "$t/attach"
"$t/attach" "$t/prompt"
