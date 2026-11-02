# OpenSSH's client programs, its settings at /etc/ssh; static PIEs, hardened, over the root's OpenSSL and zlib.
pins="OPENSSH"
needs="zlib openssl"
build() {
  CFLAGS="$hard -fPIE" LDFLAGS="$pie $LDFLAGS" LIBS='-pthread' \
    ./configure --prefix=/usr --sysconfdir=/etc/ssh --with-ssl-dir="$deps/usr" --with-zlib="$deps/usr" \
      --without-pam --without-kerberos5 --without-libedit --without-ldns --without-selinux --without-pie
  make -j"$jobs" ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan
  mkdir -p "$dest/usr/bin"
  for p in ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan; do install -m 0755 "$p" "$dest/usr/bin/$p"; done
}
