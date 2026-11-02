# zlib: libz.a and its headers, for what is linked here (OpenSSL, curl, git, OpenSSH, apk) and for the Prompt's own
# builds; position-independent, so static PIEs link it too.
pins="ZLIB"
build() {
  CFLAGS="$hard -fPIC" ./configure --prefix=/usr --static
  make -j"$jobs"
  make DESTDIR="$dest" install
}
