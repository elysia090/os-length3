# musl: the C library the Prompt's own builds link with (libc.a, its start files and headers; no libc.so, as every
# program of the root is static), at the version Alpine's is and with the security fixes Alpine's carries (aports
# 3.24-stable at 8f79d39391b46d6dbf1800fb68b8212a21d5ee2e, each patch its APKBUILD's sha512): the libc the root's
# own programs are linked with. A libc is what the stack protector and the hardening are built on: its own build
# chooses where each goes, so it is given only -O2.
pins="MUSL"
patches="musl/CVE-2026-6042.patch musl/CVE-2026-40200.patch musl/CVE-2026-107891.patch"
build() {
  CFLAGS='-O2' LDFLAGS= ./configure --prefix=/usr --disable-shared
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  # A program built against this libc alone (its headers, start files and archive) runs.
  printf '#include <stdio.h>\nint main(void) { printf("%%s\\n", "libc"); return 0; }\n' > t.c
  gcc -static -nostdinc -isystem "$dest/usr/include" -isystem "$(gcc -print-file-name=include)" \
    -B"$dest/usr/lib/" -L"$dest/usr/lib" -o t t.c && [ "$(./t)" = libc ]
}
