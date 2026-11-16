#!/bin/sh
# you, under what goes wrong: learners killed at any point while many learn and the file is remade under them;
# learners, readers and forgetters at once; a disk that fills; a file of garbage; files as big as its room and bigger;
# more places than it keeps; the longest place and the most keywords; a file that is not a file; output cut off; and
# time: its weights, a place gone a season forgotten, a clock gone back.
#
#   sh you/test/you-stress.sh [YOU]     YOU: the program (you/src/you.c, as lib/build.sh makes it).
#       A build of its own is made beside it for what wants one (lib/build.sh, CC): its file remade every 512
#       bytes, its time $YOU_NOW when set.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
you=$(cd "$(dirname "${1:-$here/../you}")" && pwd)/$(basename "${1:-$here/../you}")
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
CFLAGS="${CFLAGS:-} -DCOMPACT_EVERY=512 -DYOU_TEST_CLOCK" sh "$here/../../lib/build.sh" "$here/../src/you.c" "$t/yt"
yt=$t/yt
export HOME="$t/home"
unset YOU_EXCLUDE XDG_DATA_HOME YOU_NOW
mkdir -p "$HOME" "$t/c"
n=0
bad() { printf 'not ok %d: %s\n' "$n" "$*" >&2; exit 1; }
says() { # says WANT CMD...: CMD's output is WANT
  n=$((n + 1))
  want=$1; shift
  got=$("$@" 2>&1) || true
  [ "$got" = "$want" ] || bad "$*
  said: $got
  not:  $want"
}
fails() { # fails CMD...: CMD fails
  n=$((n + 1))
  if "$@" > /dev/null 2>&1; then bad "$* did not fail"; fi
}
# The places most of it learns: $t/c/p0 ... p39.
P=40
i=0; while [ $i -lt $P ]; do mkdir "$t/c/p$i"; i=$((i + 1)); done
# visits PROGRAM: "INDEX VISITS" for each place c/pINDEX it keeps, from the score it shows (each visit within the hour
# is four).
visits() { "$1" query --list --score c/p | awk '{ p = $2; sub(/.*\/p/, "", p); print p, $1 / 4 }' | sort -n; }
# tally FILE...: "INDEX COUNT" for the indexes the files list, one a line.
tally() { cat "$@" 2> /dev/null | sort -n | uniq -c | awk '{ print $2, $1 }'; }
# within LOW HIGH GOT: each place's GOT (INDEX VISITS) at least as LOW says and at most as HIGH says (both INDEX COUNT).
within() {
  awk 'FNR == 1 { f++ } f == 1 { lo[$1] = $2; next } f == 2 { hi[$1] = $2; next }
       { got[$1] = $2 }
       END { for (k in hi) { g = got[k] + 0; if (g < lo[k] + 0 || g > hi[k]) { print "place " k ": " g " visits, not " lo[k] + 0 "-" hi[k]; bad = 1 } }
             for (k in got) if (!(k in hi)) { print "place " k ": " got[k] " visits, never learnt"; bad = 1 }
             exit bad }' "$1" "$2" "$3"
}
# The file as it is once remade: a learner that crosses a mark has it remade by a child of its own, which holds it until
# done (so whatever holds it after waits; flock(1) is one).
settle() { flock "$YOU_DATA" true; }
# An LCG, the same in every shell: next RANDOM after $seed, 0 to 32767.
next() { seed=$(( (seed * 1103515245 + 12345) % 2147483648 )); r=$(( seed / 65536 )); }

# Killed at any point: eight learners, each learning 250 times, a third of them killed a moment after they start (the
# moment drawn from nothing to most of a run), while the file is remade every 512 bytes. A visit a learner finished is
# kept, one it never began is not, one killed is kept or not, never twice; nothing is learnt that was not; and what a
# remaking killed before its rename leaves is no more than one file beside it.
export YOU_DATA="$t/kill/db"
learner() {
  seed=$1 i=0
  while [ $i -lt 250 ]; do
    next; j=$((r % P))
    echo $j >> "$t/kill.began.$1"
    "$yt" add "$t/c/p$j" &
    pid=$!
    next
    if [ $((r % 3)) = 0 ]; then
      k=$((r % 400)); while [ $k -gt 0 ]; do k=$((k - 1)); done
      kill -9 $pid 2> /dev/null || true
    fi
    if { wait $pid; } 2> /dev/null; then echo $j >> "$t/kill.done.$1"; fi
    i=$((i + 1))
  done
}
w=1; while [ $w -le 8 ]; do learner $w & w=$((w + 1)); done
wait
n=$((n + 1))
tally "$t"/kill.done.* > "$t/lo"; tally "$t"/kill.began.* > "$t/hi"; visits "$yt" > "$t/got"
within "$t/lo" "$t/hi" "$t/got" >&2 || bad "killed learners: visits lost or made up"
n=$((n + 1))
beside=$(ls -A "$t/kill" | grep -vcx db || true)
[ "$beside" -le 1 ] || bad "killed remakings left $beside files beside it: $(ls -A "$t/kill" | tr '\n' ' ')"

# At once: six learners (250 visits each), two readers listing all it keeps the while, and one forgetter learning and
# forgetting places of its own. Every visit kept, exactly; a reader never fails but for finding nothing, and lists only
# places learnt; the forgetter forgets each place it learnt, and none of them is kept.
export YOU_DATA="$t/once/db"
mkdir -p "$t/r/x0" "$t/r/x1" "$t/r/x2"
: > "$t/once.run"
learner2() {
  seed=$1 i=0
  while [ $i -lt 250 ]; do
    next; j=$((r % P))
    "$yt" add "$t/c/p$j" || { echo "learner $1: add failed" >> "$t/once.bad"; return; }
    echo $j >> "$t/once.done.$1"
    i=$((i + 1))
  done
}
reader() {
  while [ -e "$t/once.run" ]; do
    if "$yt" query --list > "$t/once.out.$1" 2> "$t/once.err.$1"; then
      if grep -Evqx "$t/c/p[0-9]+|$t/r/x[0-9]" "$t/once.out.$1"; then echo "reader $1 listed: $(grep -Evx "$t/c/p[0-9]+|$t/r/x[0-9]" "$t/once.out.$1" | head -n 3)" >> "$t/once.bad"; fi
    elif [ "$(cat "$t/once.err.$1")" != "you: no match" ]; then
      echo "reader $1 failed: $(cat "$t/once.err.$1")" >> "$t/once.bad"
    fi
  done
}
forgetter() {
  i=0
  while [ $i -lt 60 ]; do
    x=$t/r/x$((i % 3))
    "$yt" add "$x" || echo "forgetter: add $x failed" >> "$t/once.bad"
    "$yt" remove "$x" 2>> "$t/once.bad" || echo "forgetter: remove $x failed" >> "$t/once.bad"
    i=$((i + 1))
  done
}
reader 1 & r1=$!
reader 2 & r2=$!
forgetter & f=$!
w=1; l=; while [ $w -le 6 ]; do learner2 $w & l="$l $!"; w=$((w + 1)); done
# shellcheck disable=SC2086
wait $l $f
rm "$t/once.run"
wait $r1 $r2
n=$((n + 1))
[ ! -s "$t/once.bad" ] || bad "at once: $(head -n 5 "$t/once.bad")"
n=$((n + 1))
tally "$t"/once.done.* > "$t/lo"; visits "$yt" > "$t/got"
within "$t/lo" "$t/lo" "$t/got" >&2 || bad "at once: visits lost or made up"
fails "$yt" query r/x

# A disk that fills (the most a file may be, with the signal for it ignored, as a full disk refuses a write): what
# was learnt before it filled is kept, a visit refused is not, one written in part is passed over; and when there is
# room again, it learns on. Once as it is, then remade every 512 bytes, its new places outgrowing the room the while.
for prog in "$you" "$yt"; do
  export YOU_DATA="$t/full/$(basename "$prog")/db"
  i=0; while [ $i -lt 200 ]; do mkdir -p "$t/full/n$i"; i=$((i + 1)); done
  "$prog" add "$t/c/p0" "$t/c/p1"
  settle
  size=$(wc -c < "$YOU_DATA")
  : > "$t/full.done"
  (
    trap '' XFSZ
    ulimit -f $((size / 512 + 4))
    i=0
    while [ $i -lt 200 ]; do
      if "$prog" add "$t/full/n$i" 2> /dev/null; then echo $i >> "$t/full.done"; fi
      i=$((i + 1))
    done
  )
  n=$((n + 1))
  k=$(wc -l < "$t/full.done")
  [ "$k" -gt 0 ] && [ "$k" -lt 200 ] || bad "a full disk ($prog): $k of 200 learnt, not some"
  n=$((n + 1))
  got=$("$prog" query --list full/n | sed 's|.*/n||' | sort -n)
  [ "$got" = "$(sort -n "$t/full.done")" ] || bad "a full disk ($prog): kept $(echo $got | wc -w), learnt $k"
  "$prog" add "$t/c/p2"
  says "$t/c/p2" "$prog" query c/p2
done

# A file of garbage, past the room it reads a file into, with records' tags and plausible heads through it: nothing
# found in it, nothing it does fails for it; and once remade, what was learnt after it is all there is.
export YOU_DATA="$t/junk/db"
mkdir -p "$t/junk"
dd if=/dev/urandom of="$t/junk/random" bs=65536 count=40 2> /dev/null
# (each a tag, a length from 1 to 200, its zero, then random bytes: a head that passes all but its sum)
awk 'BEGIN { srand(7); for (i = 0; i < 6000; i++) { n = 1 + int(rand() * 200); s = "you\\001\\" sprintf("%03o", n) "\\000\\000\\000";
       for (j = 0; j < 12 + n; j++) s = s "\\" sprintf("%03o", 1 + int(rand() * 255)); print s } }' > "$t/junk/heads"
while IFS= read -r l; do printf "$l"; done < "$t/junk/heads" > "$t/junk/tags"
cat "$t/junk/random" "$t/junk/tags" "$t/junk/random" > "$YOU_DATA"
fails "$you" query p
i=0; while [ $i -lt 400 ]; do "$you" add "$t/c/p$((i % 4))"; i=$((i + 1)); done
n=$((n + 1))
settle
[ "$(wc -c < "$YOU_DATA")" -lt 65536 ] || bad "garbage: not remade ($(wc -c < "$YOU_DATA") bytes)"
says "$t/c/p0
$t/c/p1
$t/c/p2
$t/c/p3" sh -c "'$you' query --list | sort"

# As big as its room, and bigger: a file of one place and nothing after it, from well inside the room it reads a file
# into to past it, found; and remade by the learner whose visit crosses its mark.
export YOU_DATA="$t/edge/db"
mkdir -p "$t/edge"
"$you" add "$t/c/p0"
cp "$YOU_DATA" "$t/edge/one"
m=110
while [ $m -le 132 ]; do
  cp "$t/edge/one" "$YOU_DATA"
  dd of="$YOU_DATA" bs=1 seek=$((m * 16384 - 30)) count=0 2> /dev/null
  says "$t/c/p0" "$you" query c/p0
  n=$((n + 1))
  "$you" add "$t/c/p1" 2> "$t/edge/err" || bad "a file of $((m * 16384 - 30)) bytes: $(cat "$t/edge/err")"
  n=$((n + 1))
  settle
  [ "$(wc -c < "$YOU_DATA")" -lt 4096 ] || bad "a file of $((m * 16384 - 30)) bytes: not remade"
  m=$((m + 1))
done
# (and byte by byte about the end of the room, read)
s=$((2097152 - 9000))
while [ $s -le 2097152 ]; do
  cp "$t/edge/one" "$YOU_DATA"
  dd of="$YOU_DATA" bs=1 seek=$s count=0 2> /dev/null
  n=$((n + 1))
  got=$("$you" query c/p0 2>&1) || true
  [ "$got" = "$t/c/p0" ] || bad "a file of $s bytes: $got"
  s=$((s + 37))
done

# More places than it keeps: 20000 learnt once each, in as few runs as their names fit, then one many times: it keeps
# working, keeps no more than it can, and finds the one.
export YOU_DATA="$t/many/db"
mkdir -p "$t/many"
awk -v t="$t/many" 'BEGIN { for (i = 0; i < 20000; i++) print t "/p" i }' > "$t/many.list"
xargs mkdir < "$t/many.list"
xargs "$you" add < "$t/many.list"
i=0; while [ $i -lt 30 ]; do "$you" add "$t/many/p7"; i=$((i + 1)); done
n=$((n + 1))
[ "$("$you" query --list | wc -l)" -le 16384 ] || bad "more places than it keeps: lists $("$you" query --list | wc -l)"
says "$t/many/p7" "$you" query many p7
# and output cut off (a pager closed): it ends as a program writing to no one does, saying nothing.
n=$((n + 1))
xargs "$you" add < "$t/many.list"
"$you" query --list 2> "$t/cut.err" | head -n 1 > /dev/null
[ ! -s "$t/cut.err" ] || bad "output cut off: $(cat "$t/cut.err")"
# One run of more places than it keeps.
n=$((n + 1))
export YOU_DATA="$t/many/db2"
set -f
# shellcheck disable=SC2046
"$you" add $(head -n 17000 "$t/many.list") 2> "$t/many.err" || [ "$(cat "$t/many.err")" = "you: too many places at once" ] || bad "17000 at once: $(cat "$t/many.err")"
set +f
"$you" add "$t/c/p3"
says "$t/c/p3" "$you" query c/p3

# The longest place a path can be (4095 bytes), learnt from in it, found and forgotten; one longer, not learnt.
export YOU_DATA="$t/long/db"
mkdir -p "$t/long"
(
  cd "$t/long"
  left=$((4095 - ${#PWD}))
  part=$(printf '%0200d' 0)
  while [ $left -gt 202 ]; do mkdir "$part"; cd "$part"; left=$((left - 201)); done
  last=$(printf "%0$((left - 1))d" 0)
  mkdir "$last"; cd "$last"
  [ ${#PWD} = 4095 ] || { echo "made ${#PWD} bytes, not 4095" >&2; exit 1; }
  "$you" add .
  mkdir x
  if "$you" add x 2> /dev/null; then echo "learnt a place of 4097 bytes" >&2; exit 1; fi
  rmdir x
  [ "$("$you" query --list | wc -c)" = 4096 ] || { echo "lists $("$you" query --list | wc -c) bytes" >&2; exit 1; }
  "$you" remove .
) || bad "the longest place"
fails "$you" query 0
# The most keywords (64), and one past them; a keyword as long as a place cannot be.
export YOU_DATA="$t/kw/db"
a70=$(printf '%070d' 0)
mkdir -p "$t/kw/$a70/p5"
"$you" add "$t/kw/$a70/p5"
k=$(i=0; while [ $i -lt 63 ]; do printf '0 '; i=$((i + 1)); done)
# shellcheck disable=SC2086
says "$t/kw/$a70/p5" "$you" query $k p5
# shellcheck disable=SC2086
says "you: too many keywords, or one too long" "$you" query $k 0 p5
says "you: too many keywords, or one too long" "$you" query "$(printf '%04096d' 0)"

# A file that is not a file: a FIFO, a directory. Nothing waits on it, nothing is learnt in it.
export YOU_DATA="$t/odd/db"
mkdir -p "$t/odd"
mkfifo "$YOU_DATA"
n=$((n + 1))
( "$you" query c > /dev/null 2>&1 & q=$!; k=0; while kill -0 $q 2> /dev/null; do k=$((k + 1)); [ $k -lt 50 ] || { kill -9 $q; exit 1; }; sleep 0.1; done ) || bad "a FIFO: query waits on it"
n=$((n + 1))
( "$you" add "$t/c/p0" > /dev/null 2>&1 & q=$!; k=0; while kill -0 $q 2> /dev/null; do k=$((k + 1)); [ $k -lt 50 ] || { kill -9 $q; exit 1; }; sleep 0.1; done; wait $q && exit 1 || exit 0 ) || bad "a FIFO: learnt in it, or waited"
rm "$YOU_DATA"; mkdir "$YOU_DATA"
fails "$you" add "$t/c/p0"
fails "$you" query c

# Time: a visit four times as much within the hour, twice within the day, half within the week, a quarter after (and
# a tie shown as zoxide shows it, to even); a clock gone back counts a visit as now; a place gone 90 days forgotten
# when the file is remade, one gone less, kept.
export YOU_DATA="$t/time/db"
T=2000000000
YOU_NOW=$T "$yt" add "$t/c/p9"
for a in "0    4.0" "3599    4.0" "3600    2.0" "86399    2.0" "86400    0.5" "604799    0.5" "604800    0.2" "-1000    4.0"; do
  set -- $a
  says "   $2 $t/c/p9" env YOU_NOW=$((T + $1)) "$yt" query --score c/p9
done
mkdir -p "$t/time/gone" "$t/time/left"
YOU_NOW=$T "$yt" add "$t/time/gone" "$t/time/left"
rmdir "$t/time/gone" "$t/time/left"
# (remade, at 89 days: both kept; at 91: the one gone 91 days forgotten, though there again)
i=0; while [ $i -lt 20 ]; do YOU_NOW=$((T + 89 * 86400)) "$yt" add "$t/c/p8"; i=$((i + 1)); done
mkdir "$t/time/left"
says "$t/time/left" env YOU_NOW=$((T + 89 * 86400)) "$yt" query time/left
rmdir "$t/time/left"
i=0; while [ $i -lt 20 ]; do YOU_NOW=$((T + 91 * 86400)) "$yt" add "$t/c/p8"; i=$((i + 1)); done
mkdir "$t/time/gone" "$t/time/left"
settle
fails env YOU_NOW=$((T + 91 * 86400)) "$yt" query time/gone
fails env YOU_NOW=$((T + 91 * 86400)) "$yt" query time/left

settle
echo "ok $n"
