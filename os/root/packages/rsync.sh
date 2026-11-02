# rsync: trees made the same here and there, sending only what differs, over ssh or with its daemon; compressed by
# zstd or zlib (the root's), its checksums by OpenSSL, ACLs and extended attributes kept (the root's acl), and its
# own popt (the root has no other). xxHash, LZ4 and IDN are left out (the root has none of them), as is what makes its
# manuals. Its daemon's unprivileged user and group are the root's nobody: said here, as left to itself configure
# reads the build machine's /etc/group.
pins="RSYNC"
needs="zlib zstd openssl acl"
build() {
  ./configure --prefix=/usr --disable-md2man --with-included-popt --with-included-zlib=no --enable-zstd \
    --disable-lz4 --disable-xxhash --enable-openssl --enable-acl-support --enable-xattr-support \
    --disable-idn --with-nobody-user=nobody --with-nobody-group=nobody
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  r="$dest/usr/bin/rsync"
  v=$("$r" -V)
  echo "$v" | head -n 1 | grep -q "version $RSYNC_VERSION "
  echo "$v" | grep -A1 '^Compress list' | grep -q zstd
  # A tree, its link and a change made since, carried across and nothing else.
  mkdir -p a/d
  echo one > a/d/f
  ln -s f a/d/l
  "$r" -a a/ b/
  cmp a/d/f b/d/f
  [ "$(readlink b/d/l)" = f ]
  echo three > a/d/f
  touch -d '2000-01-01' a/d/f
  [ "$("$r" -ai a/ b/)" = '>f.st...... d/f' ]
  cmp a/d/f b/d/f
}
