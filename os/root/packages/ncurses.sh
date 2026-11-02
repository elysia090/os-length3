# ncurses: the terminal library (wide characters), its programs (tput, tic, infocmp, clear, reset, tabs) and the
# terminfo database they and every full-screen program read, at /usr/share/terminfo; with its pkg-config files.
pins="NCURSES"
build() {
  mkdir ../o && cd ../o
  ../src/configure --prefix=/usr --libdir=/usr/lib --without-shared --with-normal --without-debug --without-ada \
    --without-cxx --without-cxx-binding --without-tests --without-manpages --enable-widec \
    --with-terminfo-dirs=/usr/share/terminfo --enable-pc-files --with-pkg-config-libdir=/usr/lib/pkgconfig
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  [ "$(TERMINFO="$dest/usr/share/terminfo" "$dest/usr/bin/tput" -T xterm-256color colors)" = 256 ]
}
