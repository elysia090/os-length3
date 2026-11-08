#!/bin/sh
# you, checked as it is used: what a query finds and in what order, what is not learnt, what is forgotten, and what
# it keeps through what goes wrong (learners at once with its remaking, a record written in part, a byte changed).
#
#   sh you/test/zoxide.sh [YOU]     YOU: the program (you/you, as lib/build.sh makes it)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
you=$(cd "$(dirname "${1:-$here/../you}")" && pwd)/$(basename "${1:-$here/../you}")
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
export YOU_DATA="$t/data/you" HOME="$t/home"
unset YOU_EXCLUDE XDG_DATA_HOME
mkdir -p "$HOME"
n=0
says() { # says WANT CMD...: CMD's output is WANT
  n=$((n + 1))
  want=$1; shift
  got=$("$@" 2>&1) || true
  [ "$got" = "$want" ] || { printf 'not ok %d: %s\n  said: %s\n  not:  %s\n' "$n" "$*" "$got" "$want" >&2; exit 1; }
}
fails() { # fails CMD...: CMD fails
  n=$((n + 1))
  if "$@" > /dev/null 2>&1; then printf 'not ok %d: %s did not fail\n' "$n" "$*" >&2; exit 1; fi
}
d() { mkdir -p "$t/$1"; echo "$t/$1"; }
# The file as it is once remade: a learner that crosses a mark has it remade by a child of its own, which holds it until
# done (so whatever holds it after waits; flock(1) is one).
settle() { flock "$YOU_DATA" true; }

# Nothing learnt: nothing found (and where it is kept made only when something is).
fails "$you" query web
[ ! -e "$YOU_DATA" ]
fails "$you"
fails "$you" query --nonsense

# Each keyword in the path in order, case aside; the last within the last part.
"$you" add "$(d p/web-42/src)" "$(d p/other)" "$(d p/Web)"
"$you" add "$t/p/web-42/src"
says "$t/p/web-42/src" "$you" query web src
says "$t/p/Web" "$you" query web
says "$t/p/Web" "$you" query WEB
says "$t/p/web-42/src" "$you" query p/web src
fails "$you" query src web
says "$t/p/web-42/src" "$you" query 42/s
# Past ASCII, case aside as zoxide has it (Rust's to_lowercase): Über by über, Κόσμος by κόσμος, Ｗｅｂ by ｗｅｂ.
"$you" add "$(d u/Über)" "$(d u/Κόσμος)" "$(d u/Ｗｅｂ)"
says "$t/u/Über" "$you" query über
says "$t/u/Κόσμος" "$you" query κόσμος
says "$t/u/Ｗｅｂ" "$you" query ｗｅｂ
"$you" remove "$t/u/Über" "$t/u/Κόσμος" "$t/u/Ｗｅｂ"
# No keywords: the place most yours; --exclude, not the place you are.
says "$t/p/web-42/src" "$you" query
says "$t/p/Web" "$you" query w
says "$t/p/Web" "$you" query --exclude "$t/p/web-42/src" -- w
says "$t/p/Web" "$you" query --exclude="$t/p/web-42/src" -- w
# --list, most yours first (more visits: more yours), --score as zoxide shows it.
"$you" add "$t/p/other" "$t/p/other"
says "$t/p/other
$t/p/web-42/src
$t/p/Web" "$you" query --list
says "  12.0 $t/p/other" "$you" query --score other

# A place made plain as a shell's $PWD is: from where it is run, without ., .. or a trailing /.
mkdir -p "$t/q/a/b"
(cd "$t/q/a" && "$you" add . b/ ./b/../b//)
says "$t/q/a" "$you" query q a
says "   8.0 $t/q/a/b" "$you" query --score q b
"$you" add /
says / sh -c "'$you' query --list | grep -x /"

# Not learnt: the home directory, what is not a directory (nothing of a command with one learnt), a name a line of
# output could not hold; $YOU_EXCLUDE in place of the home directory.
"$you" add "$HOME"
fails "$you" query home
fails "$you" add "$(d r/kept)" "$t/no/such"
fails "$you" query kept
mkdir -p "$t/line
break"
"$you" add "$t/line
break"
fails "$you" query break
YOU_EXCLUDE="$t/x/*:$t/y" "$you" add "$(d x/in)" "$(d y)" "$(d x)" "$HOME"
fails "$you" query in
says "$t/x" "$you" query x
says "$HOME" "$you" query home
fails "$you" add "$t/$(printf 'n%.0s' $(seq 5000))"

# A place no longer there is not given: the next one is; and forgotten when asked.
"$you" add "$(d gone/web)" "$(d gone/web)" "$(d gone/web)"
rmdir "$t/gone/web"
says "$t/p/Web" "$you" query web
"$you" remove "$t/p/Web"
fails "$you" query web
says "$t/p/web-42/src" "$you" query web s
fails "$you" remove "$t/p/Web"
fails "$you" remove "$t/never"

# Learners at once, and the file made again under them (every 16 KiB): no visit lost. Eight learners each learn the
# same hundred places; each place is then eight times yours.
mkdir -p "$t/c"
i=0; while [ $i -lt 100 ]; do mkdir "$t/c/p$i"; i=$((i + 1)); done
w=0; while [ $w -lt 8 ]; do
  (i=0; while [ $i -lt 100 ]; do "$you" add "$t/c/p$i"; i=$((i + 1)); done) &
  w=$((w + 1))
done
wait
says 100 sh -c "'$you' query --list --score c/p | grep -c '^  32.0 '"

# A record written in part (a disk full, a machine stopped), then more learnt: what came after it is found again; and
# a byte changed in one: that one passed over, the rest kept.
settle
printf 'you\001\377' >> "$YOU_DATA"
"$you" add "$(d after/torn)"
says "$t/after/torn" "$you" query torn
"$you" add "$(d bit/flipped)"
settle
size=$(wc -c < "$YOU_DATA")
printf X | dd of="$YOU_DATA" bs=1 seek=$((size - 3)) conv=notrunc 2> /dev/null
fails "$you" query flipped
says "$t/after/torn" "$you" query torn

# Aged: past 10000 visits in all, each cut so that they make 9000; a place under one visit forgotten.
settle
rm -f "$YOU_DATA"
"$you" add "$(d once)"
many=$(i=0; while [ $i -lt 1000 ]; do printf '%s\n' "$t/p/other"; i=$((i + 1)); done)
k=0; while [ $k -lt 11 ]; do
  # (each place on a line of its own: a name with no space in it, the test's own)
  # shellcheck disable=SC2086
  "$you" add $many
  k=$((k + 1))
done
settle
fails "$you" query once
"$you" query --score other | awk '{ if ($1 < 30000 || $1 > 40000) { print "aged to " $1; exit 1 } }'

settle
echo "ok $n"
