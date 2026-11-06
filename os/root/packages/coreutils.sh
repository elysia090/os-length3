# GNU coreutils' join (two files' lines joined on a field), fmt (paragraphs filled to a width) and b2sum (BLAKE2b
# digests): what the Prompt is asked for (issue #80) and BusyBox has not. The rest of coreutils is not taken: BusyBox
# answers to those names, as it has from the start. Nothing optional is linked (no ACLs, attributes, SELinux,
# OpenSSL, GMP), each said so it is not found by chance.
pins="COREUTILS"
build() {
  # Its configure refuses to run as root unless told (the builder's container is root's).
  FORCE_UNSAFE_CONFIGURE=1 ./configure --prefix=/usr --disable-nls --disable-acl --disable-xattr --disable-libcap \
    --without-selinux --without-openssl --without-libgmp --disable-dependency-tracking
  make -j"$jobs" src/join src/fmt src/b2sum
  for p in join fmt b2sum; do install -D -m 0755 "src/$p" "$dest/usr/bin/$p"; done
}
check() {
  for p in join fmt b2sum; do "$dest/usr/bin/$p" --version | grep -q "$COREUTILS_VERSION"; done
  printf '1 a\n2 b\n' > j1; printf '1 x\n2 y\n' > j2
  [ "$("$dest/usr/bin/join" j1 j2)" = "$(printf '1 a x\n2 b y')" ]
  [ "$(printf 'one two three four five six seven\n' | "$dest/usr/bin/fmt" -w 12)" = "$(printf 'one two\nthree four\nfive six\nseven')" ]
  # BLAKE2b-512 of "abc" (RFC 7693, appendix A).
  printf abc | "$dest/usr/bin/b2sum" | grep -q '^ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923 '
}
