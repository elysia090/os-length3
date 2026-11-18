# GNU Wget: files fetched and resumed, and sites recursively; TLS by the root's OpenSSL, which finds the root's CA
# bundle where it looks (/etc/ssl/cert.pem). What needs what the root has not (libpsl, IDN, PCRE, libuuid, Metalink,
# c-ares) is left out.
pins="WGET"
needs="openssl zlib"
tools="pkgconf"
build() {
  ./configure --prefix=/usr --sysconfdir=/etc --disable-nls --disable-rpath --with-ssl=openssl --with-zlib \
    --without-libpsl --disable-iri --disable-pcre --disable-pcre2 --without-libuuid --without-metalink --without-cares
  # wget --version repeats how it was compiled and linked: said as the root has it (what it was built against is
  # /usr there), as the builder says it in a text file.
  make -C src version.c && sed -i "s|$deps||g" src/version.c
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  v=$("$dest/usr/bin/wget" --version)
  echo "$v" | head -n 1 | grep -q "^GNU Wget $WGET_VERSION "
  echo "$v" | grep -q '+https' && echo "$v" | grep -q '+ssl/openssl'
}
