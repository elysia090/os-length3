# ncurses: the terminal library (wide characters), its programs (tput, tic, infocmp, clear, reset, tabs) and the
# terminfo database they and every full-screen program read, at /usr/share/terminfo; with its pkg-config files.
pins="NCURSES"
build() {
  mkdir ../o && cd ../o
  # Who may steer it through TERMINFO, TERMINFO_DIRS, TERMCAP and ~/.terminfo is said here, not guessed: left to
  # itself, configure decides from the build machine's own /etc/passwd whether it is built for a multiuser system,
  # and in a container with no login user it shuts root out of them. Root is the root's one user and reads them;
  # a privileged program (setuid, setcap) does not, and opens its files as the user who ran it (CVE-2023-29491).
  cf_cv_multiuser=yes ../src/configure --prefix=/usr --libdir=/usr/lib --without-shared --with-normal \
    --without-debug --without-ada --without-cxx --without-cxx-binding --without-tests --without-manpages \
    --enable-widec --with-terminfo-dirs=/usr/share/terminfo --enable-pc-files \
    --with-pkg-config-libdir=/usr/lib/pkgconfig \
    --enable-root-environ --disable-setuid-environ --disable-root-access
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  # The database it compiled, read back by path; and root, steering it by TERMINFO, finds the same entry.
  db="$dest/usr/share/terminfo"
  "$dest/usr/bin/infocmp" -A "$db" xterm-256color | grep -Eq 'colors#(256|0x100)'
  [ "$(TERMINFO="$db" "$dest/usr/bin/tput" -T xterm-256color colors)" = 256 ]
}
