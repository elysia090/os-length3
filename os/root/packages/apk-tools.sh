# apk, Alpine's package manager, and libapk; over the root's OpenSSL, zlib and zstd.
pins="APK_TOOLS"
needs="zlib openssl zstd"
tools="meson pkgconf"
build() {
  meson setup ../o --prefix=/usr --libdir=lib --buildtype=release --default-library=static -Dprefer_static=true \
    -Dc_link_args="$LDFLAGS" -Ddocs=disabled -Dhelp=disabled -Dlua=disabled -Dpython=disabled -Dtests=disabled \
    -Dzstd=enabled -Durl_backend=libfetch
  ninja -C ../o
  DESTDIR="$dest" meson install -C ../o
}
check() {
  "$dest/usr/bin/apk" --version | grep -q "$APK_TOOLS_VERSION"
}
