# attr: extended attributes (getfattr, setfattr, attr) and libattr, its settings at /etc/xattr.conf.
pins="ATTR"
build() {
  mkdir ../o && cd ../o
  ../app/configure --prefix=/usr --sysconfdir=/etc --disable-shared --enable-static --disable-nls
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
}
check() {
  "$dest/usr/bin/getfattr" --version | grep -q "$ATTR_VERSION"
}
