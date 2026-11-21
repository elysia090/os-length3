# gzip and its scripts (zcat, zgrep, zless, ...).
pins="GZIP"
build() {
  ./configure --prefix=/usr --disable-nls
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  [ "$(echo roundtrip | "$dest/usr/bin/gzip" | "$dest/usr/bin/gzip" -d)" = roundtrip ]
}
