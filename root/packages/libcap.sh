# libcap: capabilities (capsh, getcap, setcap, getpcaps), libcap and libpsx. Its programs' link ends with
# -Wl,-Bdynamic unless LIBCSTATIC says they are static, and then -lc would find Alpine's libc.so: LIBCSTATIC=yes.
# capsh's built-in help is made by a bash script (progs/mkcapshdoc.sh).
pins="LIBCAP"
tools="bash"
build() {
  set -- CC=gcc BUILD_CC=gcc AR=ar RANLIB=ranlib COPTS="$CFLAGS $CPPFLAGS" LDFLAGS="$LDFLAGS" \
    LIBCSTATIC=yes USE_GPERF=no SHARED=no DYNAMIC=no PAM_CAP=no GOLANG=no lib=lib prefix=/usr
  make -j"$jobs" "$@"
  make "$@" sbin=bin DESTDIR="$dest" install
}
check() {
  [ "$("$dest/usr/bin/capsh" --decode=0x1)" = '0x0000000000000001=cap_chown' ]
}
