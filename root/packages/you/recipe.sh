# you (z): the places a person has been, and back to one by a part of its name: what the Prompt's shell learns at
# every cd and z finds a place by (/etc/length3/shrc). Made from this repository's own source (you/zoxide.c, a
# unit of C with no C library, on lib's three headers, its own checks in you/test): a program of a few
# pages that starts, does five calls, and ends.
version=6
# ripgrep: what you's regular expressions, and its rg, are checked against (Rust's regex crate, as ripgrep runs it).
needs="ripgrep"
inputs="../module/lib/word.h ../module/lib/sys.h ../module/lib/io.h ../module/lib/build.sh ../module/you/zoxide.c ../module/you/test/zoxide.sh ../module/you/test/zoxide-stress.sh
  ../module/you/regex.c ../module/you/unicode.h ../module/you/dfa.c ../module/you/grep.c ../module/you/test/regex.sh ../module/you/test/regex-driver.c ../module/you/test/regex-corpus.txt
  ../module/you/test/regex-patterns.txt ../module/you/rg.c ../module/you/types.h ../module/you/test/rg.sh"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../module/lib/build.sh" "$here/../module/you/zoxide.c" "$dest/usr/bin/you"
}
# Its checks, then what goes wrong: learners killed while the file is remade, a full disk, garbage, its limits, time.
check() {
  sh "$here/../module/you/test/zoxide.sh" "$dest/usr/bin/you"
  sh "$here/../module/you/test/zoxide-stress.sh" "$dest/usr/bin/you"
  sh "$here/../module/you/test/regex.sh" "$deps/usr/bin/rg"
  # Its rg (you/rg.c), what it prints and how it ends, against ripgrep's; built here, not yet in the root.
  mkdir -p you-rg
  sh "$here/../module/lib/build.sh" "$here/../module/you/rg.c" you-rg/rg
  sh "$here/../module/you/test/rg.sh" "$deps/usr/bin/rg" "$PWD/you-rg/rg"
}
