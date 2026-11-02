# GNU Readline, at its makers' patch level: line editing and history for what reads lines (sqlite3's shell); its
# headers, archives and pkg-config file, over the root's ncurses. Which library that is is said here: left to itself,
# configure takes the first with tgetent, -ltinfo, which the root has only as another name for ncursesw, and its
# pkg-config file would ask for a tinfo module there is none of.
pins="READLINE"
needs="ncurses"
# Its makers' patches are written for -p0, so they are applied here, in order, rather than as patches= (-p1).
inputs="packages/readline/readline83-001 packages/readline/readline83-002 packages/readline/readline83-003
  packages/readline/readline83-004 packages/readline/readline83-005 packages/readline/readline83-006"
version=8.3.6
build() {
  [ "$READLINE_VERSION" = 8.3 ] || { echo "readline $READLINE_VERSION: root/packages/readline/ holds 8.3's patches"; exit 1; }
  for p in $inputs; do patch -p0 -s < "$here/$p"; done
  bash_cv_termcap_lib=libncursesw ./configure --prefix=/usr --disable-shared --enable-static --with-curses \
    --disable-install-examples
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  grep -q '^Requires.private: ncursesw$' "$dest/usr/lib/pkgconfig/readline.pc"
  # A program built against it reads a line it is given, and keeps it in its history.
  printf '%s\n' '#include <stdio.h>' '#include <string.h>' '#include <readline/readline.h>' '#include <readline/history.h>' \
    'int main(void) { char *l = readline(""); if (!l) return 2; add_history(l);' \
    '  return strcmp(l, "made") || history_length != 1 || strcmp(rl_library_version, "8.3"); }' > r.c
  gcc -static -I"$dest/usr/include" -o r r.c -L"$dest/usr/lib" -L"$deps/usr/lib" -lreadline -lncursesw
  echo made | ./r > /dev/null
}
