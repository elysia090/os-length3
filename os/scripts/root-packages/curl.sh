# curl: libcurl and its command, TLS by the root's OpenSSL, the root's CA bundle, and nothing it could reach a server
# by that the base's leaves out. (musl's threads are its libc's and its libpthread.a an empty one: -lpthread is
# -pthread, in the form curl's configure checks LIBS for.)
pins="CURL"
needs="zlib openssl"
tools="pkgconf"
build() {
  CFLAGS="$hard -fPIE" LDFLAGS="$pie $LDFLAGS" LIBS='-lpthread' PKG_CONFIG=pkg-config \
    ./configure --prefix=/usr --disable-shared --enable-static --disable-docs --disable-manual \
      --disable-ldap --disable-ldaps --disable-rtsp \
      --with-openssl="$deps/usr" --with-zlib="$deps/usr" --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt \
      --without-brotli --without-libidn2 --without-libpsl --without-libssh2 --without-zstd --without-nghttp2
  make -j"$jobs" CURL_LDFLAGS_BIN=-all-static
  make DESTDIR="$dest" CURL_LDFLAGS_BIN=-all-static install
}
