#!/bin/sh
# The production C parser and an independent test-only reference model, asked with truncation and mutation cases.
#   sh test/same.sh [MUK]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
if [ "$#" -ge 1 ]; then muk=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); else sh "$here/../../toolchain/build.sh" "$here/../src/muk.c" "$t/muk"; muk=$t/muk; fi
sh "$here/../../toolchain/build.sh" "$here/probe.c" "$t/probe"
node "$here/same.ts" "$muk" "$t/probe" "$t"
