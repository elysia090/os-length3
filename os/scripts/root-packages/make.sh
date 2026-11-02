# GNU make, as the base built it: static, no translations.
pins="MAKE"
build() {
  CFLAGS="$c17" LDFLAGS='-static' ./configure --prefix=/usr --disable-nls
  make -j"$jobs"
  make DESTDIR="$dest" install
}
