# curl: libcurl and its command, TLS by the root's OpenSSL, the root's CA bundle, and nothing it could reach a server
# by that a developer's root does without (LDAP, RTSP). musl's threads are its libc's and its libpthread.a an empty
# one: -lpthread is -pthread, in the form curl's configure checks LIBS for.
pins="CURL"
needs="zlib openssl"
tools="pkgconf"
build() {
  LIBS='-lpthread' ./configure --prefix=/usr --disable-shared --enable-static --disable-docs --disable-manual \
    --disable-ldap --disable-ldaps --disable-rtsp \
    --with-openssl="$deps/usr" --with-zlib="$deps/usr" --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt \
    --without-brotli --without-libidn2 --without-libpsl --without-libssh2 --without-zstd --without-nghttp2
  make -j"$jobs" CURL_LDFLAGS_BIN=-all-static
  make DESTDIR="$dest" CURL_LDFLAGS_BIN=-all-static install
}
check() {
  "$dest/usr/bin/curl" --version | grep -q "^curl $CURL_VERSION .* OpenSSL/"
  printf 'over file://\n' > a
  "$dest/usr/bin/curl" -fsS "file://$PWD/a" -o b && cmp a b
}
