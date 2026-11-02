# fortify-headers: the C library's checks of sizes (_FORTIFY_SOURCE), which musl has none of its own: headers that
# wrap musl's, put ahead of them by the root's GCC as Alpine's GCC puts Alpine's, so that what a person compiles in a
# Prompt is checked as the root's own programs were (at _FORTIFY_SOURCE=3, sizes known only as it runs as well). At
# the version Alpine's is, the archive Alpine's APKBUILD takes (by its sha512).
pins="FORTIFY_HEADERS"
build() {
  make DESTDIR="$dest" PREFIX=/usr install
}
check() {
  # A write past a buffer, of a size known only as it runs, compiled against these headers and musl's alone, stops
  # there; one that stays inside it does not.
  printf '%s\n' '#include <stdlib.h>' '#include <string.h>' \
    'int main(int argc, char **argv) { char b[8]; size_t n = strtoul(argv[1], 0, 10); memset(b, 1, n); return b[n - 1] != 1; }' > past.c
  gcc -O2 -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=3 -nostdinc -isystem "$dest/usr/include/fortify" -isystem /usr/include \
    -isystem "$(gcc -print-file-name=include)" -static -o past past.c
  ./past 8
  s=0; ./past 9 || s=$?
  [ "$s" = 132 ]
}
