# XZ Utils: xz, xzdec, lzmadec, lzmainfo, their scripts and liblzma.
pins="XZ"
build() {
  mkdir ../o && cd ../o
  ../src/configure --prefix=/usr --disable-shared --enable-static --disable-nls --disable-doc
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
}
check() {
  [ "$(echo roundtrip | "$dest/usr/bin/xz" | "$dest/usr/bin/xz" -d)" = roundtrip ]
}
