# you (z): the places a person has been, and back to one by a part of its name: what the Prompt's shell learns at
# every cd and z finds a place by (/etc/length3/shrc). Made from this repository's own source (you/src/you.c, a
# unit of C with no C library, on lib's three headers, its own checks beside it): a program of a few
# pages that starts, does five calls, and ends.
version=7
# ripgrep: what you's regular expressions, and its rg, are checked against (Rust's regex crate, as ripgrep runs it).
needs="ripgrep"
inputs="../lib/word.h ../lib/sys.h ../lib/io.h ../lib/arena.h ../lib/build.sh ../you/src/you.c ../you/src/rg.c
  ../you/src/re/automaton.h ../you/src/re/class.h ../you/src/re/unicode.h ../you/src/re/parse.h
  ../you/src/re/literal.h ../you/src/re/reverse.h ../you/src/re/word.h ../you/src/re/find.h ../you/src/re/pike.h
  ../you/src/re/dfa.h ../you/src/re/grep.h ../you/src/rg/options.h ../you/src/rg/ignore.h ../you/src/rg/print.h
  ../you/src/rg/types.h ../you/test/you.sh ../you/test/you-stress.sh ../you/test/regex.sh
  ../you/test/regex-corpus.txt ../you/test/regex-patterns.txt ../you/test/rg.sh"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../lib/build.sh" "$here/../you/src/you.c" "$dest/usr/bin/you"
}
# Its checks, then what goes wrong: learners killed while the file is remade, a full disk, garbage, its limits, time.
check() {
  sh "$here/../you/test/you.sh" "$dest/usr/bin/you"
  sh "$here/../you/test/you-stress.sh" "$dest/usr/bin/you"
  sh "$here/../you/test/regex.sh" "$deps/usr/bin/rg"
  # Its rg (you/src/rg.c), what it prints and how it ends, against ripgrep's; built here, not yet in the root.
  mkdir -p you-rg
  sh "$here/../lib/build.sh" "$here/../you/src/rg.c" you-rg/rg
  sh "$here/../you/test/rg.sh" "$deps/usr/bin/rg" "$PWD/you-rg/rg"
}
