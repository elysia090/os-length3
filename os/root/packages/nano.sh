# nano, whole: its help, justifying, mouse, file browser, histories and spell-checking; its syntaxes from libmagic
# where a file's name says none. Only translations are left out (the root has no locales).
pins="NANO"
needs="ncurses file"
build() {
  mkdir ../o && cd ../o
  ../src/configure --prefix=/usr --sysconfdir=/etc --disable-nls --enable-utf8
  make -j"$jobs"
  make DESTDIR="$dest" install
  # Its settings as the root has them: every syntax it comes with, so a file is coloured as its kind is.
  mkdir -p "$dest/etc"
  printf '%s\n' '# nano as the root has it: every syntax it comes with.' \
    'include "/usr/share/nano/*.nanorc"' 'include "/usr/share/nano/extra/*.nanorc"' > "$dest/etc/nanorc"
}
check() {
  v=$("$dest/usr/bin/nano" --version)
  echo "$v" | grep -q "version $NANO_VERSION"
  ! echo "$v" | grep -q -- '--disable-help\|--disable-justify\|--disable-libmagic'
}
