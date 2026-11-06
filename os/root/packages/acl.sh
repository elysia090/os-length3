# acl: POSIX access control lists (getfacl, setfacl, chacl) and libacl, over attr's headers.
pins="ACL"
needs="attr"
build() {
  mkdir ../o && cd ../o
  ../app/configure --prefix=/usr --sysconfdir=/etc --disable-shared --enable-static --disable-nls
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
}
check() {
  "$dest/usr/bin/getfacl" --version | grep -q "$ACL_VERSION"
  touch f && "$dest/usr/bin/getfacl" -cp f | grep -q '^user::'
}
