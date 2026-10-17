#!/usr/bin/env bash

# Source this at every release-build entry, including nested component builds.
# An environment flag is not evidence that the bootstrap is the locked one.
bootstrap_here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $(uname -sm) != 'Linux x86_64' ]] \
    || [[ $(uname -r) == *[Mm]icrosoft* ]] \
    || [[ $(uname -r) == *WSL* ]] \
    || [[ ! -f /etc/alpine-release ]]; then
  printf 'requires the independent, pinned x86-64 Linux build host\n' >&2
  return 2
fi
if [[ ! -s $bootstrap_here/installed.lock \
    || ! -s $bootstrap_here/packages.sha256 ]]; then
  printf 'bootstrap package lock has not been published\n' >&2
  return 2
fi
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C
SOURCE_DATE_EPOCH=$(sed -n 's/^DISTRIBUTION_SOURCE_DATE_EPOCH=//p' \
  "$bootstrap_here/../packaging/profile.env")
if [[ ! $SOURCE_DATE_EPOCH =~ ^[0-9]+$ ]]; then
  printf 'invalid fixed release source date\n' >&2
  return 2
fi
export SOURCE_DATE_EPOCH
export KBUILD_BUILD_USER=builder KBUILD_BUILD_HOST=build-host KBUILD_BUILD_VERSION=1
KBUILD_BUILD_TIMESTAMP=$(date -u -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%d %H:%M:%S UTC')
export KBUILD_BUILD_TIMESTAMP
umask 022
if ! awk '/^P:/ { p=substr($0,3) } /^V:/ { print p "=" substr($0,3) }' \
    /lib/apk/db/installed | sort | cmp -s "$bootstrap_here/installed.lock" -; then
  printf 'installed bootstrap population differs from the fixed lock\n' >&2
  return 2
fi
for bootstrap_tool in gcc g++ ar ld make bash flex bison bc perl pkgconf \
    pahole meson ninja tar cpio curl sha256sum mksquashfs; do
  if ! command -v "$bootstrap_tool" >/dev/null; then
    printf 'locked bootstrap tool is unavailable: %s\n' "$bootstrap_tool" >&2
    return 2
  fi
done
if [[ $(gcc -dumpmachine) != x86_64-alpine-linux-musl ]]; then
  printf 'bootstrap compiler does not target the locked Linux musl ABI\n' >&2
  return 2
fi
if ! pkgconf --exists libelf; then
  printf 'locked bootstrap is missing libelf headers\n' >&2
  return 2
fi
QM_BOOTSTRAP_ID=$(
  cd "$bootstrap_here"
  sha256sum windows.json repositories packages.world installed.lock packages.sha256 \
    environment.sh | sha256sum | cut -d' ' -f1
)
export QM_BOOTSTRAP_ID

bootstrap_cc() {
  if [[ -n ${1:-} && $(readlink -f -- "$1") != $(readlink -f /usr/bin/gcc) ]]; then
    printf 'compiler override is outside the locked bootstrap: %s\n' "$1" >&2
    return 2
  fi
  printf '/usr/bin/gcc\n'
}
