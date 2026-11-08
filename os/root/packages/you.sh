# you (z): the places a person has been, and back to one by a part of its name: what the Prompt's shell learns at
# every cd and z finds a place by (/etc/length3/shrc). Made from this repository's own source (kernel/you/zoxide.c, a
# unit of C with no C library, on kernel/lib's three headers, its own checks in kernel/you/test): a program of a few
# pages that starts, does five calls, and ends.
version=6
# ripgrep: what you's regular expressions, and its rg, are checked against (Rust's regex crate, as ripgrep runs it).
needs="ripgrep"
inputs="../../kernel/lib/word.h ../../kernel/lib/sys.h ../../kernel/lib/io.h ../../kernel/lib/build.sh ../../kernel/you/zoxide.c ../../kernel/you/test/zoxide.sh ../../kernel/you/test/zoxide-stress.sh
  ../../kernel/you/regex.c ../../kernel/you/unicode.h ../../kernel/you/dfa.c ../../kernel/you/grep.c ../../kernel/you/test/regex.sh ../../kernel/you/test/regex-driver.c ../../kernel/you/test/regex-corpus.txt
  ../../kernel/you/test/regex-patterns.txt ../../kernel/you/rg.c ../../kernel/you/types.h ../../kernel/you/test/rg.sh"
build() {
  mkdir -p "$dest/usr/bin"
  sh "$here/../../kernel/lib/build.sh" "$here/../../kernel/you/zoxide.c" "$dest/usr/bin/you"
}
# Its checks, then what goes wrong: learners killed while the file is remade, a full disk, garbage, its limits, time.
check() {
  sh "$here/../../kernel/you/test/zoxide.sh" "$dest/usr/bin/you"
  sh "$here/../../kernel/you/test/zoxide-stress.sh" "$dest/usr/bin/you"
  sh "$here/../../kernel/you/test/regex.sh" "$deps/usr/bin/rg"
  # Its rg (kernel/you/rg.c), what it prints and how it ends, against ripgrep's; built here, not yet in the root.
  mkdir -p you-rg
  sh "$here/../../kernel/lib/build.sh" "$here/../../kernel/you/rg.c" you-rg/rg
  sh "$here/../../kernel/you/test/rg.sh" "$deps/usr/bin/rg" "$PWD/you-rg/rg"
}
