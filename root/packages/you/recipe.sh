# you (z): the places a person has been, and back to one by a part of its name: what the Prompt's shell learns at
# every cd and z finds a place by (/etc/length3/shrc). Made from this repository's own source (you/zoxide/zoxide.c, a
# unit of C with no C library, on lib's three headers, its own checks beside it): a program of a few
# pages that starts, does five calls, and ends.
version=6
# ripgrep: what you's regular expressions, and its rg, are checked against (Rust's regex crate, as ripgrep runs it).
needs="ripgrep"
inputs="../module/lib/word.h ../module/lib/sys.h ../module/lib/io.h ../module/lib/build.sh ../module/you/zoxide/zoxide.c ../module/you/zoxide/zoxide.sh
  ../module/you/zoxide/zoxide-stress.sh ../module/you/lib/regex.c ../module/you/lib/unicode.h ../module/you/lib/dfa.c ../module/you/lib/grep.c
  ../module/you/ripgrep/rg.c ../module/you/ripgrep/types.h ../module/you/ripgrep/regex.sh ../module/you/ripgrep/regex-corpus.txt
  ../module/you/ripgrep/regex-patterns.txt ../module/you/ripgrep/rg.sh"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../module/lib/build.sh" "$here/../module/you/zoxide/zoxide.c" "$dest/usr/bin/you"
}
# Its checks, then what goes wrong: learners killed while the file is remade, a full disk, garbage, its limits, time.
check() {
  sh "$here/../module/you/zoxide/zoxide.sh" "$dest/usr/bin/you"
  sh "$here/../module/you/zoxide/zoxide-stress.sh" "$dest/usr/bin/you"
  sh "$here/../module/you/ripgrep/regex.sh" "$deps/usr/bin/rg"
  # Its rg (you/ripgrep/rg.c), what it prints and how it ends, against ripgrep's; built here, not yet in the root.
  mkdir -p you-rg
  sh "$here/../module/lib/build.sh" "$here/../module/you/ripgrep/rg.c" you-rg/rg
  sh "$here/../module/you/ripgrep/rg.sh" "$deps/usr/bin/rg" "$PWD/you-rg/rg"
}
