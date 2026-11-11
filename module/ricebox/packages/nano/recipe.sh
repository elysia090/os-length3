# nano, whole: its help, justifying, mouse, file browser, histories and spell-checking; its syntaxes from libmagic
# where a file's name says none. Only translations are left out (the root has no locales). Its settings as the root
# has them: /etc/nanorc (module/ricebox/etc).
pins="NANO"
needs="ncurses file"
tools="pkgconf"
inputs="etc/nanorc"
build() {
  mkdir ../o && cd ../o
  ../src/configure --prefix=/usr --sysconfdir=/etc --disable-nls --enable-utf8
  make -j"$jobs"
  make DESTDIR="$dest" install
  install -D -m 0644 "$here/etc/nanorc" "$dest/etc/nanorc"
}
check() {
  v=$("$dest/usr/bin/nano" --version)
  echo "$v" | grep -q "version $NANO_VERSION"
  echo "$v" | not grep -q -- '--disable-help\|--disable-justify\|--disable-libmagic'
  # What its settings include is there.
  for g in $(sed -n 's/^include "\(.*\)"$/\1/p' "$dest/etc/nanorc"); do ls "$dest"$g > /dev/null; done
}
