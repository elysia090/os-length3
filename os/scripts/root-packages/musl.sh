# musl: the C library the Prompt's own builds link with (libc.a, its start files and headers; no libc.so, as every
# program here is static), at the version Alpine's is and with the security fixes Alpine's carries (from aports at
# 8f79d39391b46d6dbf1800fb68b8212a21d5ee2e, 3.24-stable, each checked against its APKBUILD's sha512): the same libc
# the root's own programs are linked with.
pins="MUSL"
patches="musl/CVE-2026-6042.patch musl/CVE-2026-40200.patch musl/CVE-2026-107891.patch"
build() {
  ./configure --prefix=/usr --disable-shared
  make -j"$jobs"
  make DESTDIR="$dest" install
}
