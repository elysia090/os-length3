# Info-ZIP's Zip 3.0 (zip, zipcloak, zipnote, zipsplit), as Debian carries it: its patch series, 3.0-16 (security
# fixes, its configure made right for GCC 14 and after, no build date), applied in order. bzip2 inside an archive by
# the root's libbz2. Unzipping is BusyBox's unzip.
pins="ZIP"
needs="bzip2"
patches="typo-it-is-transferring-not-transfering.patch typo-it-is-privileges-not-priviliges.patch
  manpages-in-section-1-not-in-section-1l.patch do-not-set-unwanted-cflags.patch
  typo-it-is-preceding-not-preceeding.patch stack-markings-to-avoid-executable-stack.patch
  fclose-in-file-not-fclose-x.patch hardening-build-fix-1.patch hardening-build-fix-2.patch
  remove-build-date.patch typo-it-is-ambiguities-not-amgibuities.patch fix-build-with-gcc-14.patch
  typo-it-is-os-2-not-risc-os-2.patch buffer-overflow-unicode-filename.patch
  buffer-overflow-cve-2018-13410.patch fix-symlink-update-detection.patch fix-command-injection.patch"
build() {
  # Its configure finds bzip2 in one directory holding both the library and its header.
  mkdir ../bz && cp "$deps/usr/lib/libbz2.a" "$deps/usr/include/bzlib.h" ../bz/
  sh unix/configure gcc "-I. -DUNIX $CFLAGS $CPPFLAGS" "$(cd ../bz && pwd)"
  make -f unix/Makefile generic
  make -f unix/Makefile install prefix="$dest/usr"
}
check() {
  z="$dest/usr/bin/zip"
  "$z" -v | grep -q 'BZIP2_SUPPORT'
  mkdir -p d/s
  echo one > d/s/a
  head -c 100000 /dev/zero > d/s/z
  "$z" -qr x.zip d
  [ "$(unzip -p x.zip d/s/a)" = one ]
  [ "$(unzip -p x.zip d/s/z | wc -c)" = 100000 ]
  "$dest/usr/bin/zipnote" x.zip | grep -q '^@ d/s/a$'
}
