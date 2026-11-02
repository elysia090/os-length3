# less, Mark Nudelman's: the pager git and every program that reaches for one find. It keeps a diff's colours (-R)
# and leaves at once when what it is given fits the screen (-F), as git asks it to; over the root's ncurses. Its v
# opens $VISUAL or $EDITOR, else nano, as the root's other editing does.
pins="LESS"
needs="ncurses"
build() {
  ./configure --prefix=/usr --sysconfdir=/etc --with-regex=posix --with-editor=nano
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  "$dest/usr/bin/less" --version | head -n 1 | grep -q "^less $LESS_VERSION "
  # Not on a terminal, it passes what it is given through whole.
  [ "$(printf 'one\ntwo\n' | "$dest/usr/bin/less" -FR)" = "$(printf 'one\ntwo')" ]
}
