# GNU tar and rmt. Compressors are the root's own programs; POSIX ACLs and SELinux are not linked. Its configure
# refuses to run as root (CI's container's user) unless told the machine is a throwaway one.
pins="TAR"
build() {
  FORCE_UNSAFE_CONFIGURE=1 ./configure --prefix=/usr --disable-nls --without-posix-acls --without-selinux
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  mkdir -p d
  echo roundtrip > d/f
  "$dest/usr/bin/tar" -cf a.tar d && mkdir x && "$dest/usr/bin/tar" -xf a.tar -C x && cmp d/f x/d/f
}
