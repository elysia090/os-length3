#!/bin/sh
# you's regular expressions against Rust's regex crate as ripgrep runs it, both as rg: every pattern of
# regex-patterns.txt over regex-corpus.txt (code, punctuation, UTF-8 past ASCII, bytes that are not UTF-8, and words
# whose two rare bytes are often together where a literal is not: from, form, performance), each line's matches as
# `rg -o` gives them (empty ones too), the lines that hold one as `rg` gives them, and both with case aside (`-i`);
# then over the corpus many times over (past a block of the DFA's lanes) the lines, case aside too, and the matches;
# and the lines both ways again as the browser looks, 16 bytes a step (YOU_16). you's rg (rg.c) and ripgrep are given
# the same words each time. A pattern both refuse is the same too.
#
#   sh you/ripgrep/regex.sh RG     RG: ripgrep, to compare with; you's rg is built by lib/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
rg=$1
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
sh "$here/../../lib/build.sh" "$here/rg.c" "$t/you"
CFLAGS=-DYOU_16 sh "$here/../../lib/build.sh" "$here/rg.c" "$t/you16"
# (Past a block of the DFA's lanes.)
for k in $(seq 3000); do cat "$here/regex-corpus.txt"; done > "$t/big"
n=0 bad=0
same() { # same WHAT FILE ARGS...: ripgrep and you's rg (you, or you16 as YOU says) say the same over FILE, given ARGS
  what=$1 file=$2; shift 2
  want=$("$rg" "$@" --no-line-number --no-filename -e "$p" "$file" 2>&1) || true
  got=$("$t/${you:-you}" "$@" --no-line-number --no-filename -e "$p" "$file" 2>&1) || true
  case "$want$got" in *"regex parse error"*"regex parse error"*) return ;; esac
  [ "$want" = "$got" ] && return
  bad=$((bad + 1))
  printf 'not ok: /%s/ %s\n' "$p" "$what" >&2
  printf '%s\n' "$want" > "$t/want"; printf '%s\n' "$got" > "$t/got"
  diff "$t/want" "$t/got" | head -8 >&2 || true
}
while IFS= read -r p; do
  n=$((n + 1))
  same "-o" "$here/regex-corpus.txt" -o
  same "lines" "$here/regex-corpus.txt"
  same "-i -o" "$here/regex-corpus.txt" -i -o
  same "-i lines" "$here/regex-corpus.txt" -i
  same "lines, many" "$t/big"
  same "-i lines, many" "$t/big" -i
  same "-o, many" "$t/big" -o
  you=you16
  same "lines, many, 16 bytes a step" "$t/big"
  same "-i lines, many, 16 bytes a step" "$t/big" -i
  you=you
done < "$here/regex-patterns.txt"
[ "$bad" = 0 ] || { echo "$bad of $((n * 9)) runs differ from ripgrep's" >&2; exit 1; }
echo "ok: $n patterns, nine ways each, as ripgrep finds them"
