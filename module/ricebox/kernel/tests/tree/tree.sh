#!/bin/sh
# The tree beside Linux (tree.c): a directory with every kind of name in it (links to what is there and what is not,
# from the root and from where they are, round in a ring, forty deep and forty-one; a file with two names; a name as
# long as a name may be), made a tree, and every name of it asked of both.
#
#   sh tests/tree/tree.sh [DIR]     DIR: a directory to ask of besides (a whole root)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
sh "$here/../../../../lib/build.sh" "$here/tree.c" "$t/tree"
d=$t/d
mkdir -p "$d/a/b/c" "$d/a/empty" "$d/usr/bin" "$d/with space/é"
echo one > "$d/a/file"; echo two > "$d/a/b/c/deep"; : > "$d/usr/bin/sh"
ln "$d/a/file" "$d/a/b/second-name"
ln -s b/c "$d/a/to-c"; ln -s /a/b "$d/a/from-root"; ln -s nowhere "$d/a/dangling"; ln -s ../a "$d/a/b/up"
ln -s file "$d/a/to-file"; ln -s / "$d/a/to-root"; ln -s . "$d/a/to-here"; ln -s a/ "$d/slashed"; ln -s self "$d/self"
ln -s ring2 "$d/ring1"; ln -s ring1 "$d/ring2"; ln -s ../../usr/bin/sh "$d/a/b/sh"
ln -s a/file "$d/chain0"
i=0; while [ "$i" -lt 41 ]; do ln -s "chain$i" "$d/chain$((i + 1))"; i=$((i + 1)); done
: > "$d/$(printf '%0255d' 0)"
"$t/tree" "$d"
[ "$#" -eq 0 ] || "$t/tree" "$1"
# What a walk costs, where callgrind is: the instructions of N walks more, by N.
if command -v valgrind > /dev/null && [ "$#" -ge 1 ]; then
  ir() { valgrind --tool=callgrind --callgrind-out-file=/dev/null "$t/tree" "$1" walks "$2" 2>&1 | sed -n 's/.*Collected : //p'; }
  a=$(ir "$1" 100000); b=$(ir "$1" 200000)
  echo "a walk: $(( (b - a) / 100000 )) instructions"
fi
