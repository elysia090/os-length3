#!/bin/sh
# One model, asked twice: the same config.json given to muk on Linux (src/muk.c) and to muk where the machine is its
# own (runtime/bundle.ts, as a browser and node read it). What one refuses the other refuses, in the same words; what
# one reads the other reads. Every cut of a config.json, bytes changed in it, and each thing it can ask wrongly.
#
#   sh muk/test/bundle/same.sh [MUK]     MUK: the program (as lib/build.sh makes it; made here when not given)
#
# muk makes namespaces for what is not refused, so it is run by root (as muk.sh is).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
if [ "$#" -ge 1 ]; then muk=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); else sh "$here/../../../lib/build.sh" "$here/../../src/muk.c" "$t/muk"; muk=$t/muk; fi
sh "$here/../../../lib/build.sh" "$here/probe.c" "$t/probe"
node "$here/same.ts" "$muk" "$t/probe" "$t"
