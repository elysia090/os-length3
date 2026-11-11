# zlib: libz for what is linked here (OpenSSL, curl, git, OpenSSH, apk) and for the Prompt's own builds.
pins="ZLIB"
build() {
  ./configure --prefix=/usr --static
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  printf '#include <zlib.h>\n#include <string.h>\nint main(void) { const char *v = zlibVersion(); return strcmp(v, ZLIB_VERSION); }\n' > t.c
  gcc -static -I"$dest/usr/include" -o t t.c -L"$dest/usr/lib" -lz && ./t
}
