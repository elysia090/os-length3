# ncdu, its C line (1.x; 2.x is Zig, which the root is not built with): where a disk's room went, directory by
# directory, and deleted from where it is found; over the root's ncurses.
pins="NCDU"
needs="ncurses"
tools="pkgconf"
build() {
  ./configure --prefix=/usr --with-ncursesw
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  "$dest/usr/bin/ncdu" -v | grep -q "^ncdu $NCDU_VERSION"
  # It reads a tree with no screen to draw on, and says what it found.
  mkdir -p t/a
  head -c 100000 /dev/zero > t/a/f
  "$dest/usr/bin/ncdu" -0 -o e.json t
  grep -q '"name":"f","asize":100000' e.json
}
