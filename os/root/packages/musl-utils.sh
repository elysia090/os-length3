# getconf and iconv, as Alpine's musl-utils has them (aports' main/musl/, at the commit pinned): getconf, a value of
# the system's configuration by its name (sysconf, confstr, pathconf, as POSIX names them); iconv, text from one
# character set to another through musl's own iconv (Rich Felker's). A C file each, built against the root's musl.
pins="MUSL_GETCONF MUSL_ICONV"
build() {
  unpack MUSL_ICONV .
  mkdir -p "$dest/usr/bin"
  for p in getconf iconv; do $CC $CFLAGS $CPPFLAGS "$p.c" -o "$dest/usr/bin/$p" $LDFLAGS; done
}
check() {
  g="$dest/usr/bin/getconf" i="$dest/usr/bin/iconv"
  [ "$("$g" PAGESIZE)" = 4096 ]
  [ "$("$g" PATH_MAX /)" = 4096 ]
  "$g" -a | grep -q '^ARG_MAX'
  [ "$(printf 'caf\351\n' | "$i" -f latin1 -t utf-8)" = "café" ]
  [ "$(printf 'caf\303\251\n' | "$i" -f utf-8 -t utf-16le | od -An -tx1 | tr -d ' \n')" = 630061006600e9000a00 ]
}
