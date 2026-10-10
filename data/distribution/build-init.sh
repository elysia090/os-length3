#!/usr/bin/env bash
set -euo pipefail

# Component builders expose one machine-readable result coordinate on stdout.
# All upstream build chatter stays diagnostic, including on a cold build.
exec 3>&1
exec 1>&2

here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
repo=$(cd -- "$data/.." && pwd)

. "$data/bootstrap/environment.sh"
. "$data/sources.env"
. "$here/profile.env"

upstream=$data/upstream
build=${QM_INIT_BUILD_ROOT:-${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}/libqm-init-build}
out=${QM_OUTPUT_ROOT:-${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}/libqm-init-output}
jobs=${QM_JOBS:-$(nproc)}
mkdir -p "$upstream" "$build" "$out"

resolve_cc() {
  bootstrap_cc "${QM_INIT_CC:-}"
}

fetch_sha512() {
  local url=$1 target=$2 expected=$3
  if [[ ! -f $target ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$target.part" "$url"
    mv "$target.part" "$target"
  fi
  printf '%s  %s\n' "$expected" "$target" | sha512sum --check --status
}

extract_once() {
  local archive=$1 directory=$2
  if [[ ! -d $directory ]]; then
    tar -C "$build" --no-same-owner -xf "$archive"
  fi
}

configure_install() {
  local source=$1 root=$2
  shift 2
  if [[ -f $root/.complete ]]; then
    return
  fi
  mkdir -p "$root"
  (
    cd "$source"
    CC="$cc" LDFLAGS="$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" ./configure \
      --prefix=/usr --sysconfdir=/etc --disable-rpath "$@"
    make -j"$jobs"
    make DESTDIR="$root" install
  ) >&2
  touch "$root/.complete"
}

cc=$(resolve_cc)
target=$($cc -dumpmachine)
case $target in
  x86_64-*-linux-musl) ;;
  *)
    printf 'init compiler must target x86_64 Linux musl, got %s\n' \
      "$target" >&2
    exit 1
    ;;
esac

skalibs_tar=$upstream/skalibs-$SKALIBS_VERSION.tar.gz
execline_tar=$upstream/execline-$EXECLINE_VERSION.tar.gz
s6_tar=$upstream/s6-$S6_VERSION.tar.gz
s6_rc_tar=$upstream/s6-rc-$S6_RC_VERSION.tar.gz
mdevd_tar=$upstream/mdevd-$MDEVD_VERSION.tar.gz
fetch_sha512 "$SKALIBS_URL" "$skalibs_tar" "$SKALIBS_SHA512"
fetch_sha512 "$EXECLINE_URL" "$execline_tar" "$EXECLINE_SHA512"
fetch_sha512 "$S6_URL" "$s6_tar" "$S6_SHA512"
fetch_sha512 "$S6_RC_URL" "$s6_rc_tar" "$S6_RC_SHA512"
fetch_sha512 "$MDEVD_URL" "$mdevd_tar" "$MDEVD_SHA512"

skalibs_source=$build/skalibs-$SKALIBS_VERSION
execline_source=$build/execline-$EXECLINE_VERSION
s6_source=$build/s6-$S6_VERSION
s6_rc_source=$build/s6-rc-$S6_RC_VERSION
mdevd_source=$build/mdevd-$MDEVD_VERSION
extract_once "$skalibs_tar" "$skalibs_source"
extract_once "$execline_tar" "$execline_source"
extract_once "$s6_tar" "$s6_source"
extract_once "$s6_rc_tar" "$s6_rc_source"
extract_once "$mdevd_tar" "$mdevd_source"

recipe_key=$(printf '%s\n' "$SKALIBS_SHA512" "$EXECLINE_SHA512" \
  "$S6_SHA512" "$S6_RC_SHA512" "$MDEVD_SHA512" \
  "$($cc --version | sed -n '1p')" "$QM_BOOTSTRAP_ID" 'static-init-closure-v2' | \
  sha256sum | cut -d' ' -f1)
service_source=$here/services
bash "$here/check-service-sources.sh" "$service_source"
service_key=$(
  cd "$here"
  { find services boot -type f -print0 | sort -z | xargs -0 sha256sum; \
    sha256sum project-boot-services.sh; } | sha256sum | \
    cut -d' ' -f1
)
prefix=$build/$recipe_key
skalibs_root=$prefix/skalibs-root
execline_root=$prefix/execline-root
s6_root=$prefix/s6-root
s6_rc_root=$prefix/s6-rc-root
mdevd_root=$prefix/mdevd-root

configure_install "$skalibs_source" "$skalibs_root" \
  --disable-shared --enable-static --enable-pkgconfig \
  --with-sysdep-devurandom=yes \
  --with-sysdep-posixspawnearlyreturn=no \
  --with-sysdep-procselfexe=/proc/self/exe \
  --with-sysdep-selectinfinite=yes
configure_install "$execline_source" "$execline_root" \
  --disable-shared --enable-static-libc --enable-pkgconfig \
  --enable-multicall \
  --with-sysdeps="$skalibs_root/usr/lib/skalibs/sysdeps" \
  --with-include="$skalibs_root/usr/include" \
  --with-lib="$skalibs_root/usr/lib"
configure_install "$s6_source" "$s6_root" \
  --disable-shared --enable-static-libc --enable-pkgconfig \
  --with-sysdeps="$skalibs_root/usr/lib/skalibs/sysdeps" \
  --with-include="$skalibs_root/usr/include" \
  --with-include="$execline_root/usr/include" \
  --with-lib="$skalibs_root/usr/lib" \
  --with-lib="$execline_root/usr/lib"
configure_install "$s6_rc_source" "$s6_rc_root" \
  --disable-shared --enable-static-libc --enable-pkgconfig \
  --with-sysdeps="$skalibs_root/usr/lib/skalibs/sysdeps" \
  --with-include="$skalibs_root/usr/include" \
  --with-include="$execline_root/usr/include" \
  --with-include="$s6_root/usr/include" \
  --with-lib="$skalibs_root/usr/lib" \
  --with-lib="$execline_root/usr/lib" \
  --with-lib="$s6_root/usr/lib"
configure_install "$mdevd_source" "$mdevd_root" \
  --disable-shared --enable-static-libc \
  --with-sysdeps="$skalibs_root/usr/lib/skalibs/sysdeps" \
  --with-include="$skalibs_root/usr/include" \
  --with-lib="$skalibs_root/usr/lib"

publication_key=$(printf '%s\n' "$recipe_key" "$service_key" \
  'component-linked-init-package-set-v3' | \
  sha256sum | cut -d' ' -f1)
publication=$build/$publication_key
candidate=$publication/root.partial
root=$publication/root
prepared_root=$publication/packages
package_specs=(
  "skalibs:$skalibs_root" "execline:$execline_root" "s6:$s6_root"
  "s6-rc:$s6_rc_root" "mdevd:$mdevd_root"
)

if [[ ! -f $publication/.complete ]]; then
  if [[ -e $candidate || -e $root || -e $prepared_root ]]; then
    printf 'incomplete init publication exists: %s\n' "$publication" >&2
    exit 1
  fi
  mkdir -p "$publication" "$candidate" "$prepared_root"
  for specification in "${package_specs[@]}"; do
    name=${specification%%:*}
    package_root=${specification#*:}
    prepared=$prepared_root/$name
    bash "$here/clone-tree.sh" "$package_root" "$prepared"
    find "$prepared" -name .complete -delete
    rm -rf "$prepared/usr/include" "$prepared/usr/lib/pkgconfig" \
      "$prepared/usr/share/doc" "$prepared/usr/share/man"
    bash "$here/clone-tree.sh" "$prepared" "$candidate"
  done
  service_root=$prepared_root/base-services
  install -d -m 0755 "$service_root/usr/libexec/system"
for script in init boot console halt ready network; do
    install -m 0755 "$here/boot/$script" "$service_root/usr/libexec/system/$script"
  done
  compiled=$service_root/etc/s6-rc/compiled/current
  mkdir -p "$(dirname -- "$compiled")"
  "$candidate/usr/bin/s6-rc-compile" "$compiled" "$service_source"
  bash "$here/project-boot-services.sh" "$service_source" "$compiled" \
    "$service_root/etc/s6-rc/compiled/boot" \
    "$candidate/usr/bin/s6-rc-db" "$candidate/usr/bin/s6-rc-compile"
  for path in n db resolve.cdb; do
    if [[ ! -f $compiled/$path ]]; then
      printf 'compiled service database is incomplete: %s\n' "$path" >&2
      exit 1
    fi
  done
  bash "$here/clone-tree.sh" "$service_root" "$candidate"
  mv -- "$candidate" "$root"
  touch "$publication/.complete"
fi

required_executables=(
  usr/bin/execlineb usr/bin/s6-svscan usr/bin/s6-supervise
  usr/bin/s6-rc usr/bin/s6-rc-init usr/bin/s6-rc-db
  usr/bin/mdevd usr/bin/mdevd-coldplug
)
required_files=(
  etc/s6-rc/compiled/current/n etc/s6-rc/compiled/current/db
  etc/s6-rc/compiled/current/resolve.cdb
)
for path in "${required_executables[@]}"; do
  if [[ ! -x $root/$path ]]; then
    printf 'init closure path is missing: /%s\n' "$path" >&2
    exit 1
  fi
done
for path in "${required_files[@]}"; do
  if [[ ! -f $root/$path ]]; then
    printf 'init closure file is missing: /%s\n' "$path" >&2
    exit 1
  fi
done

package_outputs=("base-services:$prepared_root/base-services")
for specification in "${package_specs[@]}"; do
  name=${specification%%:*}
  package_outputs+=("$name:$prepared_root/$name")
done
bash "$here/emit-package-set.sh" "$out" \
  x86_64-linux-musl-init "$publication_key" \
  "${package_outputs[@]}" >&3
