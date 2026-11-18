# OpenSSH's client programs, its settings at /etc/ssh, over the root's OpenSSL and zlib.
pins="OPENSSH"
needs="zlib openssl"
build() {
  LIBS='-pthread' ./configure --prefix=/usr --sysconfdir=/etc/ssh --with-ssl-dir="$deps/usr" --with-zlib="$deps/usr" \
    --without-pam --without-kerberos5 --without-libedit --without-ldns --without-selinux
  make -j"$jobs" ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan
  mkdir -p "$dest/usr/bin"
  for p in ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan; do install -m 0755 "$p" "$dest/usr/bin/$p"; done
}
check() {
  "$dest/usr/bin/ssh" -V 2>&1 | grep -q "^OpenSSH_$OPENSSH_VERSION"
  "$dest/usr/bin/ssh-keygen" -q -t ed25519 -N '' -C t -f k && "$dest/usr/bin/ssh-keygen" -lf k.pub | grep -q ED25519
}
