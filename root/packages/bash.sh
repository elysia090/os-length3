# GNU bash, at its makers' patch level, for what is written for it (#!/bin/bash, #!/usr/bin/env bash, bash -c).
# The Prompt's own shell stays sh (BusyBox's ash), which the app's shell integration is written for. Its line
# editing is its own readline, over the root's ncurses; bash's own malloc is left out (musl's is the root's).
pins="GNU_BASH"
needs="ncurses"
# Its makers' patches are written for -p0, so they are applied here, in order, rather than as patches= (-p1).
inputs="packages/bash/bash53-001 packages/bash/bash53-002 packages/bash/bash53-003 packages/bash/bash53-004
  packages/bash/bash53-005 packages/bash/bash53-006 packages/bash/bash53-007 packages/bash/bash53-008
  packages/bash/bash53-009 packages/bash/bash53-010 packages/bash/bash53-011 packages/bash/bash53-012
  packages/bash/bash53-013 packages/bash/bash53-014 packages/bash/bash53-015 packages/bash/bash53-016
  packages/bash/bash53-017 packages/bash/bash53-018 packages/bash/bash53-019 packages/bash/bash53-020"
version=5.3.20
build() {
  [ "$GNU_BASH_VERSION" = 5.3 ] || { echo "bash $GNU_BASH_VERSION: root/packages/bash/ holds 5.3's patches"; exit 1; }
  for p in $inputs; do patch -p0 -s < "$here/$p"; done
  ./configure --prefix=/usr --disable-nls --without-bash-malloc --with-curses
  make -j"$jobs"
  make DESTDIR="$dest" install
  # Its loadable builtins, and what building one takes (headers, bash.pc, Makefile.inc): a static bash loads none
  # ("Dynamic loading not supported"), so they are not kept.
  rm -rf "${dest:?}/usr/lib/bash" "${dest:?}/usr/include/bash" "${dest:?}/usr/lib/pkgconfig/bash.pc"
}
check() {
  b="$dest/usr/bin/bash"
  "$b" --version | head -n 1 | grep -qF "version $version(1)-release"
  # What bash is reached for: arrays, associative arrays, [[ ]] with a pattern, process substitution.
  [ "$("$b" -c 'a=(x y z); declare -A m=([k]=v); [[ abc == a* ]] && echo "${#a[@]} ${m[k]} ${a[*]:1} $(cat <(echo ps))"')" = '3 v y z ps' ]
}
