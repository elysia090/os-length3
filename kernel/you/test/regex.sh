#!/bin/sh
# you's regular expressions against Rust's regex crate as ripgrep runs it: every pattern of regex-patterns.txt over
# regex-corpus.txt (code, punctuation, UTF-8 past ASCII), each line's matches as `rg -o` gives them, the same; a
# pattern both refuse is the same too.
#
#   sh kernel/you/test/regex.sh RG [CC]     RG: ripgrep, to compare with; the driver is built by kernel/lib/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
rg=$1
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
sh "$here/../../lib/build.sh" "$here/regex-driver.c" "$t/re" 2>/dev/null
n=0 bad=0
while IFS= read -r p; do
  n=$((n + 1))
  want=$("$rg" -o --no-line-number --no-filename -e "$p" "$here/regex-corpus.txt" 2>&1) || true
  got=$("$t/re" "$p" < "$here/regex-corpus.txt" 2>&1) || true
  case "$want$got" in *"regex parse error"*"bad pattern"*) continue ;; esac
  if [ "$want" != "$got" ]; then
    bad=$((bad + 1))
    printf 'not ok: /%s/\n' "$p" >&2
    printf '%s\n' "$want" > "$t/want"; printf '%s\n' "$got" > "$t/got"
    diff "$t/want" "$t/got" | head -8 >&2 || true
  fi
done < "$here/regex-patterns.txt"
[ "$bad" = 0 ] || { echo "$bad of $n patterns differ from ripgrep's" >&2; exit 1; }
echo "ok: $n patterns, as ripgrep finds them"
