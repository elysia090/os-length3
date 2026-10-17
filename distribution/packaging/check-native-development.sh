#!/usr/bin/env bash
set -euo pipefail

if [[ $# == 3 && $1 == --inside ]]; then
  root=$(realpath -e -- "$2")
  archive=$(realpath -e -- "$3")
  mount --bind "$root" "$root"
  mount -o remount,bind,ro "$root"
  mount --bind /dev "$root/dev"
  mount -t proc proc "$root/proc"
  mount -t tmpfs -o size=256m,mode=1777 tmpfs "$root/tmp"
  cp -- "$archive" "$root/tmp/zlib-source.tar.xz"
  env -i PATH=/usr/bin:/usr/sbin:/bin:/sbin HOME=/root \
    chroot "$root" /bin/sh -e -s <<'GUEST'
PATH=/usr/bin:/usr/sbin:/bin:/sbin
export PATH
report_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for log in /tmp/zlib-configure.log /tmp/zlib-build.log \
        /tmp/zlib-test.log /tmp/zlib-install.log; do
      test -f "$log" || continue
      printf '%s\n' "native development: $log" >&2
      tail -n 40 "$log" >&2
    done
  fi
  exit "$status"
}
trap report_failure EXIT
cd /tmp
tar -xJf zlib-source.tar.xz
set -- zlib-*/
test "$#" -eq 1
test -d "$1"
cd "$1"
./configure --static --prefix=/usr >/tmp/zlib-configure.log
make -s -j2 >/tmp/zlib-build.log
make -s test >/tmp/zlib-test.log
make -s install DESTDIR=/tmp/zlib-installed >/tmp/zlib-install.log
test -f /tmp/zlib-installed/usr/include/zlib.h
test -f /tmp/zlib-installed/usr/lib/libz.a
printf '#include <zlib.h>\nint main(void) { return zlibVersion()[0] != ZLIB_VERSION[0]; }\n' \
  >/tmp/project-consumer.c
cc /tmp/project-consumer.c -I/tmp/zlib-installed/usr/include \
  /tmp/zlib-installed/usr/lib/libz.a -o /tmp/project-consumer
/tmp/project-consumer
GUEST
  printf 'native development: green (upstream configure, make, test, install, consumer)\n'
  exit 0
fi

if [[ $# != 2 || ! -d $1 || ! -f $2 ]]; then
  printf 'usage: %s RELEASE_ROOT ZLIB_SOURCE_ARCHIVE\n' "$0" >&2
  exit 2
fi
root=$(realpath -e -- "$1")
archive=$(realpath -e -- "$2")
if [[ $(id -u) != 0 ]]; then
  printf 'native development: private mount namespace requires root\n' >&2
  exit 1
fi
unshare --mount --propagation private bash "$0" --inside "$root" "$archive"
