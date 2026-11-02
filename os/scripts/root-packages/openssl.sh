# OpenSSL: its library and command, its settings and certificates at /etc/ssl; a static PIE, hardened. c_rehash goes:
# it is a perl script, the root has no perl, and its certificates come as one bundle.
pins="OPENSSL"
tools="perl"
build() {
  ./Configure linux-x86_64 --prefix=/usr --libdir=lib --openssldir=/etc/ssl \
    no-shared no-tests no-module no-dso no-docs $hard -fPIE $pie
  make -j"$jobs"
  make DESTDIR="$dest" install_sw
  rm -f "$dest/usr/bin/c_rehash"
}
