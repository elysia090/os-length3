# OpenSSL: its library and command, its settings and certificates at /etc/ssl. c_rehash is not installed: it is a perl
# script, the root has no perl, and its certificates come as one bundle.
pins="OPENSSL"
tools="perl"
build() {
  ./Configure linux-x86_64 --prefix=/usr --libdir=lib --openssldir=/etc/ssl no-shared no-tests no-module no-dso no-docs
  make -j"$jobs"
  make DESTDIR="$dest" install_sw
  install -Dm644 apps/openssl.cnf "$dest/etc/ssl/openssl.cnf"
  rm -f "${dest:?}/usr/bin/c_rehash"
}
check() {
  "$dest/usr/bin/openssl" version | grep -q "^OpenSSL $OPENSSL_VERSION "
  [ "$(printf abc | "$dest/usr/bin/openssl" dgst -sha256 -r | cut -d' ' -f1)" = \
    ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad ]
  # The staged binary still names /etc/ssl. Point this build-time check at its
  # staged configuration; the assembled-root assay uses the default path.
  (
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT HUP INT TERM
    OPENSSL_CONF="$dest/etc/ssl/openssl.cnf" "$dest/usr/bin/openssl" req -x509 -newkey ec \
      -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=localhost \
      -keyout "$work/key.pem" -out "$work/cert.pem" -days 1
    "$dest/usr/bin/openssl" x509 -in "$work/cert.pem" -noout -subject | grep -q 'CN *= *localhost'
  )
}
