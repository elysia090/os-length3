# htop: what runs, what it costs and whose it is, sorted, searched, and signalled or traced (strace) where it is
# shown; over the root's ncurses. What needs what the root has not (lm-sensors, delay accounting over netlink,
# hwloc, PCP, libunwind, a demangler) is left out, as is dropping capabilities, which the root's root has no
# reason to.
pins="HTOP"
needs="ncurses"
tools="pkgconf"
build() {
  ./configure --prefix=/usr --sysconfdir=/etc --enable-static --enable-unicode --disable-sensors \
    --disable-capabilities --disable-delayacct --disable-hwloc --disable-pcp --disable-demangling --enable-backtrace=no
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  "$dest/usr/bin/htop" --version | grep -q "^htop $HTOP_VERSION"
}
