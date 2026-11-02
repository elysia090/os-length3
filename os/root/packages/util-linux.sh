# util-linux: lsblk, blkid, fdisk, sfdisk and cfdisk (over the root's ncurses), mount and umount, dmesg, and their
# libraries (libuuid, libblkid, libmount, libsmartcols, libfdisk). Nothing else optional is linked (no udev, systemd,
# readline, libmagic, libcap-ng, econf), each said so it is not found by chance. Its idmapped-mount hook needs
# linux/openat2.h, which 2.42.4 does not include: the patch is for that release, and another is reviewed before it
# is pinned.
pins="UTIL_LINUX"
needs="ncurses"
patches="util-linux/2.42.4-openat2.patch"
build() {
  [ "$UTIL_LINUX_VERSION" = 2.42.4 ] || { echo "util-linux $UTIL_LINUX_VERSION: review util-linux/2.42.4-openat2.patch"; exit 1; }
  mkdir ../o && cd ../o
  ../src/configure --prefix=/usr --bindir=/usr/bin --sbindir=/usr/bin --libdir=/usr/lib \
    --disable-shared --enable-static --disable-rpath \
    --enable-libuuid --enable-libblkid --enable-libmount --enable-libsmartcols --enable-libfdisk \
    --disable-all-programs --enable-lsblk --enable-fdisks --enable-blkid --enable-mount --enable-dmesg \
    --disable-nls --disable-asciidoc --disable-poman --disable-bash-completion \
    --disable-makeinstall-chown --disable-makeinstall-setuid --disable-makeinstall-tty-setgid \
    --with-ncursesw --without-udev --without-systemd --without-readline --without-tinfo --without-libmagic \
    --without-cap-ng --without-econf --without-python
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
}
check() {
  for p in lsblk blkid fdisk sfdisk cfdisk mount umount dmesg; do "$dest/usr/bin/$p" --version | grep -q "$UTIL_LINUX_VERSION"; done
}
