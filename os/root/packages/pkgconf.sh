# pkgconf, also as pkg-config, its tools (bomtool, spdxtool, pccritic) and libpkgconf.
pins="PKGCONF"
build() {
  mkdir ../o && cd ../o
  ../src/configure --prefix=/usr --disable-shared --enable-static
  make -j"$jobs" LDFLAGS="$allstatic"
  make DESTDIR="$dest" LDFLAGS="$allstatic" install
  ln -sf pkgconf "$dest/usr/bin/pkg-config"
}
check() {
  mkdir pc && printf 'Name: t\nDescription: t\nVersion: 1.2\nCflags: -It\n' > pc/t.pc
  [ "$(PKG_CONFIG_LIBDIR="$PWD/pc" "$dest/usr/bin/pkg-config" --cflags --modversion t | tr '\n' ' ')" = '1.2 -It ' ]
}
