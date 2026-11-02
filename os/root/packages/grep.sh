# GNU grep, with egrep and fgrep: the searches a developer's hands know (-r with --include and --exclude, context,
# colour). Perl's regular expressions (-P) are left out (the root has no PCRE2), as is libsigsegv.
pins="GREP"
build() {
  ./configure --prefix=/usr --disable-nls --disable-perl-regexp --without-libsigsegv
  make -j"$jobs"
  make DESTDIR="$dest" install
}
check() {
  mkdir -p s/a s/b
  echo needle > s/a/x.ts
  echo needle > s/b/x.js
  [ "$("$dest/usr/bin/grep" -rl --include='*.ts' needle s)" = s/a/x.ts ]
  [ "$(printf 'a\nb\nc\n' | "$dest/usr/bin/grep" -A1 '^a' | tail -n 1)" = b ]
}
