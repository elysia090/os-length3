# strace: what a program asks of the kernel and the signals it gets, as they happen. It traces where a Prompt runs
# on the machine (ptrace); a translated one has no kernel of its own under it to trace. 64-bit programs only (the
# root has no others), and no stack traces (no libunwind or libdw in the root), each said.
pins="STRACE"
build() {
  ./configure --prefix=/usr --enable-mpers=no --enable-stacktrace=no --disable-gcc-Werror \
    --without-libunwind --without-libdw --without-libiberty --without-libselinux
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  "$dest/usr/bin/strace" -V | head -n 1 | grep -q "version $STRACE_VERSION"
  # What echo writes is seen as it writes it.
  "$dest/usr/bin/strace" -qq -e trace=write -o t.log echo hi > /dev/null && grep -q 'write(1, "hi\\n", 3)' t.log
}
