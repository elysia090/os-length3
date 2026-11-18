# GNU make.
pins="MAKE"
build() {
  ./configure --prefix=/usr --disable-nls
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  printf 'all: a\n\techo made\na:\n\ttouch a\n' > Makefile
  [ "$("$dest/usr/bin/make" -s)" = made ] && [ -f a ]
}
