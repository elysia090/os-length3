# iproute2: ip, ss, tc, bridge and the statistics tools (misc/), their tables at /usr/share/iproute2. Nothing optional
# is linked (PKG_CONFIG=false: no libmnl, libelf, libcap or selinux), and tc has its queueing disciplines built in
# (SHARED_LIBS=n), there being no libraries to load.
pins="IPROUTE2"
tools="bison flex"
build() {
  PKG_CONFIG=false sh configure --include_dir "$PWD/include" --libbpf_force off --prefix /usr --libdir /usr/lib
  set -- PKG_CONFIG=false SHARED_LIBS=n SUBDIRS='lib ip tc bridge misc' HOSTCC=gcc
  make -j"$jobs" "$@"
  make "$@" PREFIX=/usr SBINDIR=/usr/bin DESTDIR="$dest" install
}
check() {
  "$dest/usr/bin/ip" -V | grep -q "iproute2-$IPROUTE2_VERSION"
  "$dest/usr/bin/ss" -V | grep -q "iproute2-$IPROUTE2_VERSION"
}
