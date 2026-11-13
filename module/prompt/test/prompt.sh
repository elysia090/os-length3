#!/bin/sh
# The terminal endpoint alone: no muk, OCI, namespaces or box startup are needed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cargo build --locked --release --manifest-path "$here/../Cargo.toml"
cp "$here/../target/release/prompt" "$t/prompt"
python3 "$here/attach.py" "$t/prompt"
