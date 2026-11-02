# pv: how far a pipe has got, how fast it moves and when it will be done; its width from the root's terminfo.
pins="PV"
needs="ncurses"
build() {
  ./configure --prefix=/usr --disable-nls
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  "$dest/usr/bin/pv" --version | head -n 1 | grep -q "^pv $PV_VERSION"
  [ "$(head -c 1048576 /dev/zero | "$dest/usr/bin/pv" -q | wc -c)" = 1048576 ]
}
