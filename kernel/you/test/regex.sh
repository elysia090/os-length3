#!/bin/sh
# you's regular expressions against Rust's regex crate as ripgrep runs it: every pattern of regex-patterns.txt over
# regex-corpus.txt (code, punctuation, UTF-8 past ASCII and bytes that are not UTF-8), each line's matches as `rg -o`
# gives them (empty ones too), the lines that hold one as `rg` gives them, and both with case aside (`-i`); then the
# lines over the corpus many times over (past a block of the DFA's lanes). A pattern both refuse is the same too.
#
#   sh kernel/you/test/regex.sh RG     RG: ripgrep, to compare with; the driver is built by kernel/lib/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
rg=$1
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
sh "$here/../../lib/build.sh" "$here/regex-driver.c" "$t/re" 2>/dev/null
for k in $(seq 300); do cat "$here/regex-corpus.txt"; done > "$t/big"
n=0 bad=0
same() { # same WHAT FILE RG-ARGS -- RE-ARGS: the two say the same over FILE
  what=$1 file=$2; shift 2
  a=""; while [ "$1" != -- ]; do a="$a $1"; shift; done; shift
  want=$("$rg" $a --no-line-number --no-filename -e "$p" "$file" 2>&1) || true
  got=$("$t/re" "$@" "$p" < "$file" 2>&1) || true
  case "$want$got" in *"regex parse error"*"bad pattern"*) return ;; esac
  [ "$want" = "$got" ] && return
  bad=$((bad + 1))
  printf 'not ok: /%s/ %s\n' "$p" "$what" >&2
  printf '%s\n' "$want" > "$t/want"; printf '%s\n' "$got" > "$t/got"
  diff "$t/want" "$t/got" | head -8 >&2 || true
}
while IFS= read -r p; do
  n=$((n + 1))
  same "-o" "$here/regex-corpus.txt" -o -- 
  same "lines" "$here/regex-corpus.txt" -- -l
  same "-i -o" "$here/regex-corpus.txt" -i -o -- -i
  same "-i lines" "$here/regex-corpus.txt" -i -- -i -l
  same "lines, many" "$t/big" -- -l
done < "$here/regex-patterns.txt"
[ "$bad" = 0 ] || { echo "$bad of $((n * 5)) runs differ from ripgrep's" >&2; exit 1; }
echo "ok: $n patterns, five ways each, as ripgrep finds them"
