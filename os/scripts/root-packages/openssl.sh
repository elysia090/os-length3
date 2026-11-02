# OpenSSL: its library and command, its settings and certificates at /etc/ssl. c_rehash is not installed: it is a perl
# script, the root has no perl, and its certificates come as one bundle.
pins="OPENSSL"
tools="perl"
build() {
  ./Configure linux-x86_64 --prefix=/usr --libdir=lib --openssldir=/etc/ssl no-shared no-tests no-module no-dso no-docs
  make -j"$jobs"
  make DESTDIR="$dest" install_sw
  rm -f "${dest:?}/usr/bin/c_rehash"
}
check() {
  "$dest/usr/bin/openssl" version | grep -q "^OpenSSL $OPENSSL_VERSION "
  [ "$(printf abc | "$dest/usr/bin/openssl" dgst -sha256 -r | cut -d' ' -f1)" = \
    ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad ]
}
