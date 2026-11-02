# tmux: terminals that outlive the connection they were opened over, split and switched; over libevent and the root's
# ncurses. Inside it, TERM is tmux-256color, an entry the root's terminfo has: said here, as left to itself configure
# asks the build machine's terminfo. Its settings as the root has them: /etc/tmux.conf (root/etc), read by it in its
# check.
pins="TMUX"
needs="libevent ncurses"
# bison: its configure asks for a yacc, though its parser comes made.
tools="pkgconf bison"
inputs="etc/tmux.conf"
build() {
  ./configure --prefix=/usr --enable-static --with-TERM=tmux-256color
  make -j"$jobs"
  make DESTDIR="$dest" install
  install -D -m 0644 "$here/etc/tmux.conf" "$dest/etc/tmux.conf"
}
check() {
  t="$dest/usr/bin/tmux"
  [ "$("$t" -V)" = "tmux $TMUX_VERSION" ]
  # A session started with no terminal runs what it is given, and what it wrote is read back from its pane.
  "$t" -S "$PWD/s" -f "$dest/etc/tmux.conf" new-session -d -x 80 -y 24 'echo made-here; sleep 30'
  [ "$("$t" -S "$PWD/s" show -gv history-limit)" = 50000 ]
  i=0
  until "$t" -S "$PWD/s" capture-pane -p | grep -q made-here; do
    i=$((i + 1)); [ "$i" -lt 50 ] || { "$t" -S "$PWD/s" kill-server; exit 1; }; sleep 0.1
  done
  "$t" -S "$PWD/s" kill-server
}
