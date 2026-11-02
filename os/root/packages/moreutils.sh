# moreutils' C programs a shell reaches for: sponge (a file rewritten from what was read of it, as `sort f | sponge
# f`), ifne (a command run only when there is input), isutf8, and errno (an errno's name, number and words, either
# way). Its Perl ones (ts, chronic, vidir, vipe, combine, zrun) are left out (the root has no Perl), as are pee and
# mispipe (sh's own tee >(...) and pipefail), parallel (GNU parallel's name), lckdo (flock) and ifdata (ip).
pins="MOREUTILS"
build() {
  make -j"$jobs" sponge ifne isutf8 errno
  for p in sponge ifne isutf8 errno; do install -D -m 0755 "$p" "$dest/usr/bin/$p"; done
}
check() {
  b="$dest/usr/bin"
  printf 'b\na\n' > f
  sort f | "$b/sponge" f
  [ "$(cat f)" = "$(printf 'a\nb')" ]
  [ -z "$(printf '' | "$b/ifne" echo ran)" ]
  [ "$(echo x | "$b/ifne" cat)" = x ]
  [ "$("$b/errno" ENOENT)" = 'ENOENT 2 No such file or directory' ]
  [ "$("$b/errno" 2)" = 'ENOENT 2 No such file or directory' ]
  printf 'made \343\201\202\n' | "$b/isutf8"
  printf '\377\n' | not "$b/isutf8" > /dev/null
}
