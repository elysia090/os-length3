# Zstandard: zstd and its other names and scripts, and libzstd. It reads gzip, xz and lz4 by the root's own programs,
# not linked libraries: each is said off (HAVE_*=0), so none is found by chance; no legacy formats.
pins="ZSTD"
build() {
  set -- CC=gcc AR=ar PREFIX=/usr ZSTD_LEGACY_SUPPORT=0 HAVE_ZLIB=0 HAVE_LZMA=0 HAVE_LZ4=0
  make -j"$jobs" "$@" zstd
  make -C lib "$@" DESTDIR="$dest" install-pc install-static install-includes
  make -C programs "$@" DESTDIR="$dest" install
}
check() {
  [ "$(echo roundtrip | "$dest/usr/bin/zstd" | "$dest/usr/bin/zstd" -d)" = roundtrip ]
}
