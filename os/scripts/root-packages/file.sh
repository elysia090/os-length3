# file and libmagic, with its compiled database at /usr/share/misc/magic.mgc. It reads compressed files by the root's
# own decompressors, not linked libraries: each library it could link is said off, so none is found by chance.
pins="FILE"
build() {
  mkdir ../o && cd ../o
  ../src/configure --prefix=/usr --disable-shared --enable-static --disable-libseccomp \
    --disable-zlib --disable-bzlib --disable-xzlib --disable-zstdlib --disable-lzlib --disable-lrziplib
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
}
check() {
  printf '#!/bin/sh\necho\n' > s
  "$dest/usr/bin/file" -m "$dest/usr/share/misc/magic.mgc" s | grep -q 'shell script'
}
