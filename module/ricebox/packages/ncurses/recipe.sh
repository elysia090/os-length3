# ncurses: the terminal library (wide characters), its programs (tput, tic, infocmp, clear, reset, tabs) and the
# terminfo database they and every full-screen program read, at /usr/share/terminfo; with its pkg-config files,
# which say what building against it takes (not the flags it was itself built with).
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
    --with-pkg-config-libdir=/usr/lib/pkgconfig --disable-pkg-ldflags \
    --enable-root-environ --disable-setuid-environ --disable-root-access
  make -j"$jobs"
  make DESTDIR="$dest" install
  # The names other systems build against, for the same libraries: -lncurses, -lcurses and -ltinfo (terminfo is
  # inside it here), -lform, -lmenu and -lpanel, their pkg-config modules, and <ncursesw/curses.h> where Debian
  # puts it.
  for l in ncurses curses tinfo; do ln -s libncursesw.a "$dest/usr/lib/lib$l.a"; done
  for l in form menu panel; do ln -s "lib${l}w.a" "$dest/usr/lib/lib$l.a"; done
  for m in ncurses form menu panel; do ln -s "${m}w.pc" "$dest/usr/lib/pkgconfig/$m.pc"; done
  ln -s . "$dest/usr/include/ncursesw"
  # The names kitty and Ghostty give TERM (xterm-kitty, xterm-ghostty), for ncurses's own entries for them: reached
  # over SSH from either, the root's full-screen programs know the terminal they draw on.
  ln -s ../k/kitty "$dest/usr/share/terminfo/x/xterm-kitty"
  ln -s ../g/ghostty "$dest/usr/share/terminfo/x/xterm-ghostty"
}
check() {
  # The database it compiled, read back by path; and root, steering it by TERMINFO, finds the same entry.
  db="$dest/usr/share/terminfo"
  "$dest/usr/bin/infocmp" -A "$db" xterm-256color | grep -Eq 'colors#(256|0x100)'
  [ "$(TERMINFO="$db" "$dest/usr/bin/tput" -T xterm-256color colors)" = 256 ]
  for t in xterm-kitty xterm-ghostty tmux-256color alacritty foot wezterm; do "$dest/usr/bin/infocmp" -A "$db" "$t" > /dev/null; done
  # A program built against it by another system's names reads the same.
  printf '%s\n' '#include <ncursesw/curses.h>' '#include <term.h>' \
    'int main(void) { setupterm("xterm-256color", 1, 0); return tigetnum("colors") != 256; }' > c.c
  gcc -static -I"$dest/usr/include" -o c c.c -L"$dest/usr/lib" -lncurses && TERMINFO="$db" ./c
}
