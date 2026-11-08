# you (z): the places a person has been, and back to one by a part of its name: what the Prompt's shell learns at
# every cd and z finds a place by (/etc/length3/shrc). Made from this repository's own source (you/zoxide.c, a
# unit of C with no C library, on lib's three headers, its own checks in you/test): a program of a few
# pages that starts, does five calls, and ends.
version=6
# ripgrep: what you's regular expressions, and its rg, are checked against (Rust's regex crate, as ripgrep runs it).
needs="ripgrep"
inputs="../../lib/word.h ../../lib/sys.h ../../lib/io.h ../../lib/build.sh ../../you/zoxide.c ../../you/test/zoxide.sh ../../you/test/zoxide-stress.sh
  ../../you/regex.c ../../you/unicode.h ../../you/dfa.c ../../you/grep.c ../../you/test/regex.sh ../../you/test/regex-driver.c ../../you/test/regex-corpus.txt
  ../../you/test/regex-patterns.txt ../../you/rg.c ../../you/types.h ../../you/test/rg.sh"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../../lib/build.sh" "$here/../../you/zoxide.c" "$dest/usr/bin/you"
}
# Its checks, then what goes wrong: learners killed while the file is remade, a full disk, garbage, its limits, time.
check() {
  sh "$here/../../you/test/zoxide.sh" "$dest/usr/bin/you"
  sh "$here/../../you/test/zoxide-stress.sh" "$dest/usr/bin/you"
  sh "$here/../../you/test/regex.sh" "$deps/usr/bin/rg"
  # Its rg (you/rg.c), what it prints and how it ends, against ripgrep's; built here, not yet in the root.
  mkdir -p you-rg
  sh "$here/../../lib/build.sh" "$here/../../you/rg.c" you-rg/rg
  sh "$here/../../you/test/rg.sh" "$deps/usr/bin/rg" "$PWD/you-rg/rg"
}
