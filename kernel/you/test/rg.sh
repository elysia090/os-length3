#!/bin/sh
# you's rg against ripgrep: a tree with what its walk must leave out and let back in (a repository's .gitignore and its
# !, .ignore, .rgignore, hidden files, a binary one, a directory too deep), each case run by both, what they print and
# how they end the same. ripgrep is run with --sort path (its order: the names' order, as you's rg walks).
#
#   sh kernel/you/test/rg.sh RG YOU_RG     RG: ripgrep; YOU_RG: kernel/you/rg.c, as kernel/lib/build.sh makes it
set -eu
rg=$1 you=$2
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/w" && cd "$t/w"
mkdir -p .git src/deep/deeper .hidden build docs
printf 'build/\n*.log\n!keep.log\n/docs/drafts\n' > .gitignore
printf 'secret.txt\n' > .ignore
printf '!secret.txt\nvendored/\n' > src/.rgignore
printf 'fn main() {\n    let needle = 1;\n}\n// Needle again\n' > src/a.rs
printf 'needle in ts\nother\nneedle twice needle\na.b axb\n' > src/b.ts
printf 'needle\n' > build/c.rs
printf 'needle\n' > x.log
printf 'needle kept\n' > keep.log
printf 'needle secret\n' > secret.txt
printf 'needle secret below\n' > src/secret.txt
printf 'needle hidden\n' > .hidden/h.txt
printf 'deep needle\n' > src/deep/d.md
printf 'deeper needle\n' > src/deep/deeper/e.md
printf 'bin\000needle\n' > src/bin.dat
printf 'line1\nline2\nneedle3\nline4\nline5\nline6\nneedle7\nline8\n' > ctx.txt
printf 'all: needle\n' > Makefile
printf 'x%.0s' $(seq 400) > long.txt && printf ' needle\n' >> long.txt
printf 'no newline needle' > tail.txt
n=0 bad=0
same() { # same ARGS...: both say the same, and end the same
  n=$((n + 1))
  set +e
  # (Standard input /dev/null: with no path, both search a pipe or a file there, as rg does, not the tree.)
  want=$("$rg" --sort path "$@" < /dev/null 2>&1; echo "status $?")
  got=$("$you" "$@" < /dev/null 2>&1; echo "status $?")
  set -e
  [ "$want" = "$got" ] && return
  bad=$((bad + 1))
  printf 'not ok %d: rg %s\n' "$n" "$*" >&2
  printf '%s\n' "$want" > "$t/want"; printf '%s\n' "$got" > "$t/got"
  diff "$t/want" "$t/got" | head -12 >&2 || true
}
same needle
same -n needle
same -i NEEDLE
same -S Needle
same -S needle
same -s Needle
same -w needle
same -x needle
same -v needle ctx.txt
same -c needle
same --count-matches needle
same -l needle
same --files-without-match needle
same -o 'needle\w*'
same -n -C1 needle ctx.txt src/b.ts
same -n -A2 needle ctx.txt
same -n -B2 needle ctx.txt
same -m1 needle
same -F a.b src/b.ts
same a.b src/b.ts
same -e needle -e other src/b.ts
same -g '*.ts' needle
same -g '!*.ts' needle
same -g 'src/**' needle
same -t rust needle
same -T rust needle
same -t ts -t make needle
same --hidden needle
same --no-ignore needle
same -uu needle
same --files
same --files -g '*.rs'
same --files -t md
same --max-depth 1 needle
same -H needle src/b.ts
same -I needle
same --column needle
same --vimgrep needle
same --max-columns 20 needle
same --max-columns 20 --max-columns-preview needle
same --null -l needle
same -p needle
same --color always needle
same --color always --heading -n needle src
same needle src/bin.dat
same -c needle src/bin.dat
same needle nowhere
same nothing-here
same -q needle
same -q nothing-here
same needle tail.txt
same -n needle tail.txt ctx.txt
same '^needle' ctx.txt
same 'needle[0-9]$' ctx.txt
# Standard input searched when it is a pipe and no path is named.
n=$((n + 1))
want=$(printf 'a needle\nb\n' | "$rg" needle; echo "status $?")
got=$(printf 'a needle\nb\n' | "$you" needle; echo "status $?")
[ "$want" = "$got" ] || { bad=$((bad + 1)); printf 'not ok %d: rg needle < a pipe\n%s\n%s\n' "$n" "$want" "$got" >&2; }
echo "rg: $n cases, $bad not the same"
[ "$bad" = 0 ]
