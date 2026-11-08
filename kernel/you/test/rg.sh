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
printf 'needle\nother\n' > pats.txt
printf 'ctx.txt\n' > extra.ignore
# Links the walk passes over, but -L follows: to a file, and to a directory above (a loop).
mkdir -p links && ln -s ../src/a.rs links/a.rs && ln -s .. links/up
n=0 bad=0
apart() { # apart ARGS...: both say the same on each of standard output and error, and end the same (an error rg says
  # at once, before what it holds back for standard output, comes in its own order)
  n=$((n + 1))
  set +e
  "$rg" --sort path "$@" < /dev/null > "$t/want" 2> "$t/want-err"; ws=$?
  "$you" "$@" < /dev/null > "$t/got" 2> "$t/got-err"; gs=$?
  set -e
  cmp -s "$t/want" "$t/got" && cmp -s "$t/want-err" "$t/got-err" && [ "$ws" = "$gs" ] && return
  bad=$((bad + 1))
  printf 'not ok %d: rg %s (status %s, %s)\n' "$n" "$*" "$ws" "$gs" >&2
  diff "$t/want" "$t/got" | head -6 >&2 || true
  diff "$t/want-err" "$t/got-err" | head -6 >&2 || true
}
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
# Replaced (-r), as ripgrep expands it: the match, $$, and a name of no group (nothing).
same -r X needle
same -o -r '[$0]' needle
same -r '${0}!' needle ctx.txt
same -r '$$ $nothing' needle src/b.ts
same -r '[$1]' '(needle)(\d)' ctx.txt
same -o -r '$2-$1' '(\w+) (needle)' src/b.ts
same -r '${n}!' '(?P<n>need)le' src/b.ts
same -r '<$1a>' '(n)eedle' ctx.txt
same -r '($1)' '(x)?needle' ctx.txt
# Patterns from a file, a line each; none at all, nothing found.
same -f pats.txt src
same -f /dev/null ctx.txt
same -e line1 -f pats.txt ctx.txt
# Globs with braces, and case aside.
same -g '*.{rs,ts}' needle
same -g '!*.{rs,ts,md}' -l needle
same --iglob '*.RS' needle
same --glob-case-insensitive -g '*.RS' -l needle
# Kinds: added, made of others, cleared, listed.
same --type-add 'web:*.ts' -t web needle
same --type-add 'both:include:rust,ts' -t both -l needle
same --type-clear rust --type-add 'rust:*.md' -t rust -l needle
same --type-add 'oops' -t oops needle
same -t nosuch needle
same --type-list
# What is printed of a line, and around it.
same --trim needle
same -b needle ctx.txt
same -b -o needle src/b.ts
same -n -b --column needle ctx.txt
same --passthru needle ctx.txt
same -n --passthru needle ctx.txt
same --include-zero -c needle src
same --context-separator XX -A1 needle ctx.txt
same --no-context-separator -A1 needle ctx.txt
same --field-match-separator @ --field-context-separator '#' -n -H -A1 needle ctx.txt
# What the walk leaves out: files too large, ignore files given or not heeded; in reverse order; binary ones searched.
same --max-filesize 10 -l needle
same --max-filesize 1K -l needle
same --max-filesize 1.5K needle
same --ignore-file extra.ignore -l needle
same --no-ignore-vcs -l needle
same --no-ignore-dot -l needle
same --sortr path -l needle
same --binary needle
same --binary -c needle
same --pcre2 needle
same -g '*.nothing' needle
same --max-depth 0 needle
# Links followed (-L): to a file, and to a directory above, said to be a loop.
apart -L -l needle
apart --follow --files links
# Binary files as ripgrep reads them. One the walk comes to is read 64 KiB at a time, each read after the last line it
# had whole; a read that holds a NUL is not searched, and what was found before it stands, said to have stopped there
# (its count not said: -c finds nothing in it). One named is looked over in its first 64 KiB, and after that each line
# about to be printed: one with a NUL is said to be binary in its place, and nothing more printed.
mkdir -p "$t/b" && cd "$t/b"
lines() { awk -v n="$2" 'BEGIN { for (i = 0; i < n; i++) printf "line %05d %s\n", i, (i % 97 == 5 ? "needle" : "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") }' > "$1"; }
nul_at() { printf '\000' | dd of="$1" bs=1 seek="$2" conv=notrunc 2> /dev/null; }
lines early.txt 3000 && nul_at early.txt 300
lines second.txt 3000 && nul_at second.txt 100000
lines third.txt 3000 && nul_at third.txt 150000
lines clean.txt 3000
lines named.txt 3000 && nul_at named.txt 120000
same needle
same -n needle
same -c needle
same -c needle early.txt second.txt
same -l needle
same -q needle
same -o needle
same --heading needle
same --files-without-match needle
same needle named.txt
same -n needle second.txt
same -B1 -n needle early.txt
same -A1 needle early.txt
same -c -B1 needle early.txt
# A literal whose two rarest bytes are often together where it is not (performance's f and m, three apart, as in from
# and form): the pair it is looked for by chosen again by the text, what is found the same.
awk 'BEGIN { for (i = 0; i < 20000; i++) print (i % 50 == 7 ? "the performance of it" : "from a form, the firm from forms") }' > pair.txt
same -c performance pair.txt
same -n -o performance pair.txt
same -c -i PERFORMANCE pair.txt
cd "$t/w"
# Standard input searched when it is a pipe and no path is named.
n=$((n + 1))
want=$(printf 'a needle\nb\n' | "$rg" needle; echo "status $?")
got=$(printf 'a needle\nb\n' | "$you" needle; echo "status $?")
[ "$want" = "$got" ] || { bad=$((bad + 1)); printf 'not ok %d: rg needle < a pipe\n%s\n%s\n' "$n" "$want" "$got" >&2; }
echo "rg: $n cases, $bad not the same"
[ "$bad" = 0 ]
