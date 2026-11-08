#!/bin/sh
# otter, checked as it is used: the catalog by kind and mark, wrapped at the width; a command of each mark said; the
# person's language; whatis and apropos as man-db's say, and their status when nothing is found.
#
#   sh kernel/otter/test/otter.sh [OTTER]     OTTER: the program (as kernel/lib/build.sh makes it)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
otter=$(cd "$(dirname "${1:-$here/../otter}")" && pwd)/$(basename "${1:-$here/../otter}")
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
n=0
says() { # says WANT CMD...: CMD's output is WANT
  n=$((n + 1))
  want=$1; shift
  got=$("$@" 2>&1) || true
  [ "$got" = "$want" ] || { printf 'not ok %d: %s\n  said: %s\n  not:  %s\n' "$n" "$*" "$got" "$want" >&2; exit 1; }
}
ends() { # ends STATUS CMD...: CMD ends STATUS
  n=$((n + 1))
  want=$1; shift
  st=0; "$@" > /dev/null 2>&1 || st=$?
  [ "$st" = "$want" ] || { printf 'not ok %d: %s ended %s, not %s\n' "$n" "$*" "$st" "$want" >&2; exit 1; }
}

# A table of a few commands, one of each mark, and their pages (English, and one in Japanese).
tab=$(printf '\t')
cat > "$t/commands" <<EOF
# a comment, passed over
ls${tab}files${tab}+${tab}
du${tab}files${tab}x${tab}says "98", natively "100"
nano${tab}editor${tab}t${tab}
vim${tab}editor${tab}-${tab}vi nano
getconf${tab}core${tab}-${tab}
EOF
mkdir -p "$t/pages/pages.en/common" "$t/pages/pages.en/linux" "$t/pages/pages.ja/common"
printf '# ls\n\n> List directory contents.\n> Zebracolumns are shown with -C.\n> More information: <https://example.org/ls>.\n\n- An example:\n\n`ls -l`\n' > "$t/pages/pages.en/common/ls.md"
printf '# ls\n\n> ディレクトリの中身を一覧表示します。\n> もっと詳しく: <https://example.org/ls>。\n' > "$t/pages/pages.ja/common/ls.md"
printf '# du\n\n> Disk usage.\n' > "$t/pages/pages.en/linux/du.md"
printf '# vim\n\n> Vi IMproved.\n' > "$t/pages/pages.en/common/vim.md"
export OTTER_TABLE="$t/commands" OTTER_PAGES="$t/pages"
unset LENGTH3_LANG COLUMNS
# A Prompt that shows output alone (the desktop app's), until the terminal's own case below.
export TERM=dumb

# The catalog: each kind once, in the table's order, its names under each mark, runs first.
says "What runs here: ✓ runs  ▢ needs a terminal  ✗ not yet here  — not in this root

files        ✓ ls
             ✗ du
editor       ▢ nano
             — vim
core         — getconf

otter NAME: what it is and whether it runs here. otter -k WORD: what is about WORD.
Each program says how it is used with --help, and tldr NAME shows its common uses." "$otter"

# Where the Prompt is a terminal (the app's on the web, one over SSH), what draws on a screen runs: under ✓, and no ▢.
says "What runs here: ✓ runs  ✗ not yet here  — not in this root

files        ✓ ls
             ✗ du
editor       ✓ nano
             — vim
core         — getconf

otter NAME: what it is and whether it runs here. otter -k WORD: what is about WORD.
Each program says how it is used with --help, and tldr NAME shows its common uses." env TERM=xterm-256color "$otter"
says "nano - (no page says what it is)
  ✓ runs here
  more: nano --help; tldr nano" env TERM=xterm-256color "$otter" nano

# Wrapped at the width, the names going on under the first.
long=""
for k in $(seq 30); do long="$long name$k${tab}text${tab}+${tab}
"; done
printf '%s' "$long" | sed 's/^ //' > "$t/long"
OTTER_TABLE="$t/long" COLUMNS=40 "$otter" > "$t/out"
[ "$(sed -n 3p "$t/out")" = "text         ✓ name1 name2 name3 name4" ] || { echo "not ok: wrapped at 40: $(sed -n 3p "$t/out")" >&2; exit 1; }
[ "$(sed -n 4p "$t/out")" = "               name5 name6 name7 name8" ] || { echo "not ok: the next line: $(sed -n 4p "$t/out")" >&2; exit 1; }
awk 'length > 40 && NR > 2 && !/^otter|^Each/ { exit 1 }' "$t/out" || { echo 'not ok: a line past 40' >&2; exit 1; }

# A command of each mark: what it is (every line of its page but the link), and what is so of it here.
says "ls - List directory contents.
       Zebracolumns are shown with -C.
  ✓ runs here
  more: ls --help; tldr ls" "$otter" ls
says 'du - Disk usage.
  ✗ in the root, not yet running here: says "98", natively "100"
  more: du --help; tldr du' "$otter" du
says "vim - Vi IMproved.
  — not in this root; instead: vi nano" "$otter" vim
says "getconf - (no page says what it is)
  — not in this root" "$otter" getconf
ends 1 "$otter" nothing-at-all
ends 0 "$otter" ls vim

# In Japanese, from the Japanese page where there is one, else the English.
says "ls - ディレクトリの中身を一覧表示します。
  ✓ ここで動きます
  詳しく: ls --help; tldr ls" env LENGTH3_LANG=ja "$otter" ls
says "du - Disk usage.
  ✗ root にありますが、ここではまだ動きません: says \"98\", natively \"100\"
  詳しく: du --help; tldr du" env LENGTH3_LANG=ja "$otter" du

# whatis and apropos, by the name otter is run by, or by -f and -k.
ln -s "$otter" "$t/whatis"
ln -s "$otter" "$t/apropos"
says "ls (1) - List directory contents.
vim (1) - Vi IMproved.
nothing-at-all: nothing appropriate." "$t/whatis" ls vim nothing-at-all
ends 16 "$t/whatis" nothing-at-all
ends 0 "$t/whatis" ls
says "ls (1) - List directory contents." "$otter" -f ls
# apropos reads the programs this machine has (ls is one) and their pages' first lines, as man-db's reads NAME.
says "ls (1) - List directory contents." "$t/apropos" DIRECTORY
says "ls (1) - List directory contents." "$otter" -k directory
says "zebracolumns: nothing appropriate." "$otter" -k zebracolumns
says "no-such-word-anywhere: nothing appropriate." "$t/apropos" no-such-word-anywhere
ends 16 "$t/apropos" no-such-word-anywhere

# No table: said, not a catalog of nothing.
ends 1 env OTTER_TABLE="$t/none" "$otter"

echo "ok: $n checks"
