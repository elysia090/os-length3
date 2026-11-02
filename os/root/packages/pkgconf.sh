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
  # A module's version, compared and given; its flags, as a build asks for them.
  mkdir pc && printf 'Name: t\nDescription: t\nVersion: 1.2\nCflags: -It\nLibs: -lt\n' > pc/t.pc
  export PKG_CONFIG_LIBDIR="$PWD/pc"
  "$dest/usr/bin/pkg-config" --atleast-version 1.1 t && ! "$dest/usr/bin/pkg-config" --atleast-version 1.3 t
  [ "$("$dest/usr/bin/pkg-config" --modversion t)" = 1.2 ]
  [ "$("$dest/usr/bin/pkg-config" --cflags --libs t)" = '-It -lt' ]
}
