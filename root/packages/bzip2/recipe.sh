# bzip2 and libbz2. Its Makefile has no DESTDIR and links with CFLAGS (so -static goes there), copies bzip2 to bunzip2
# and bzcat, and links its scripts' other names by absolute paths: here each other name is a link beside its program.
pins="BZIP2"
build() {
  make -j"$jobs" CC=gcc CFLAGS="$CFLAGS -static -D_FILE_OFFSET_BITS=64" LDFLAGS="$LDFLAGS" bzip2 bzip2recover libbz2.a
  make CFLAGS="$CFLAGS -static -D_FILE_OFFSET_BITS=64" LDFLAGS="$LDFLAGS" PREFIX="$dest/usr" install
  cd "$dest/usr/bin"
  for l in bunzip2:bzip2 bzcat:bzip2 bzcmp:bzdiff bzegrep:bzgrep bzfgrep:bzgrep bzless:bzmore; do
    ln -sf "${l#*:}" "${l%%:*}"
  done
}
check() {
  [ "$(echo roundtrip | "$dest/usr/bin/bzip2" | "$dest/usr/bin/bzcat")" = roundtrip ]
}
