# entr: a command run again each time one of the files it is given changes (inotify).
pins="ENTR"
build() {
  ./configure
  make -j"$jobs"
  make PREFIX=/usr DESTDIR="$dest" install
}
check() {
  # It runs what it is given at once, for the files read from its input, and (-z) leaves when that is done.
  echo one > f
  [ "$(echo f | "$dest/usr/bin/entr" -nz cat f)" = one ]
}
