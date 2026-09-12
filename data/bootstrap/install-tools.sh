#!/bin/sh
set -eu

# This command operates only inside the disposable, pinned Linux build host.
# Resolution is an explicit maintenance operation. Normal installation consumes
# the retained, signed APK files and never re-resolves their dependencies.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=${QM_BOOTSTRAP_WORK:-/build/bootstrap}
cache=$work/packages
mode=${1:-install}
case $(uname -sm) in 'Linux x86_64') ;; *) echo 'requires the x86-64 Linux build host' >&2; exit 2;; esac
test "$(id -u)" = 0
test -f /etc/alpine-release
case $(cat /etc/alpine-release) in 3.24.*) ;; *) echo 'requires Alpine 3.24 build host' >&2; exit 2;; esac
mkdir -p "$cache"

case $mode in
  resolve)
    apk --repositories-file "$here/repositories" update
    # Package names are checked-in data, not shell syntax.
    xargs apk --repositories-file "$here/repositories" fetch --recursive --output "$cache" < "$here/packages.world"
    ;;
  install)
    test -s "$here/packages.sha256"
    (cd "$cache" && sha256sum -c "$here/packages.sha256")
    ;;
  *) echo 'usage: install-tools.sh [install|resolve]' >&2; exit 2;;
esac

# Alpine verifies each retained package signature against its trusted keyring.
apk --no-network --repositories-file /dev/null add "$cache"/*.apk
awk '/^P:/ { p=substr($0,3) } /^V:/ { print p "=" substr($0,3) }' \
  /lib/apk/db/installed | LC_ALL=C sort > "$work/installed.lock"
(cd "$cache" && sha256sum ./*.apk | LC_ALL=C sort -k2) > "$work/packages.sha256"
if test "$mode" = install; then
  cmp "$here/installed.lock" "$work/installed.lock"
fi
printf 'bootstrap packages: %s\n' "$work"
