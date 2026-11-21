# GNU patch. It does not carry extended attributes over (no libattr linked).
pins="PATCH"
build() {
  ./configure --prefix=/usr --disable-nls --disable-xattr
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  printf 'a\nb\n' > f
  printf -- '--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n' > p
  "$dest/usr/bin/patch" -s f p && [ "$(cat f)" = "$(printf 'a\nc')" ]
}
