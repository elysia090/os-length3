# you (z): the places a person has been, and back to one by a part of its name: what the Prompt's shell learns at
# every cd and z finds a place by (/etc/length3/shrc). Made from this repository's own source (you/zoxide/zoxide.c, a
# unit of C with no C library, on lib's three headers, its own checks beside it): a program of a few
# pages that starts, does five calls, and ends.
version=6
# ripgrep: what you's regular expressions, and its rg, are checked against (Rust's regex crate, as ripgrep runs it).
needs="ripgrep"
inputs="../lib/word.h ../lib/sys.h ../lib/io.h ../lib/build.sh ../you/zoxide/zoxide.c ../you/zoxide/zoxide.sh
  ../you/zoxide/zoxide-stress.sh ../you/lib/regex.c ../you/lib/unicode.h ../you/lib/dfa.c ../you/lib/grep.c
  ../you/ripgrep/rg.c ../you/ripgrep/types.h ../you/ripgrep/regex.sh ../you/ripgrep/regex-corpus.txt
  ../you/ripgrep/regex-patterns.txt ../you/ripgrep/rg.sh"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../lib/build.sh" "$here/../you/zoxide/zoxide.c" "$dest/usr/bin/you"
}
# Its checks, then what goes wrong: learners killed while the file is remade, a full disk, garbage, its limits, time.
check() {
  sh "$here/../you/zoxide/zoxide.sh" "$dest/usr/bin/you"
  sh "$here/../you/zoxide/zoxide-stress.sh" "$dest/usr/bin/you"
  sh "$here/../you/ripgrep/regex.sh" "$deps/usr/bin/rg"
  # Its rg (you/ripgrep/rg.c), what it prints and how it ends, against ripgrep's; built here, not yet in the root.
  mkdir -p you-rg
  sh "$here/../lib/build.sh" "$here/../you/ripgrep/rg.c" you-rg/rg
  sh "$here/../you/ripgrep/rg.sh" "$deps/usr/bin/rg" "$PWD/you-rg/rg"
}
