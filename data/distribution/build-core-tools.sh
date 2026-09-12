#!/usr/bin/env bash
set -euo pipefail

# Component builders expose one machine-readable result coordinate on stdout.
# All upstream build chatter stays diagnostic, including on a cold build.
exec 3>&1
exec 1>&2

here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
repo=$(cd -- "$data/.." && pwd)

if [[ ${QM_BOOTSTRAP_ACTIVE:-0} != 1 ]]; then
  if ! command -v nix >/dev/null 2>&1; then
    printf 'the core-tools build requires Nix for its pinned bootstrap\n' >&2
    exit 2
  fi
  scratch_root=${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}
  exec nix develop --no-write-lock-file "path:$data/bootstrap" -c \
    env QM_BOOTSTRAP_ACTIVE=1 QM_SCRATCH_ROOT="$scratch_root" \
      bash "$here/build-core-tools.sh" "$@"
fi
. "$data/sources.env"
. "$here/profile.env"

upstream=$data/upstream
# Package compilation is an expensive, reproducible checkpoint.  Keep it in
# the repository's ignored Windows-side temp tree by default so a new WSL
# process does not silently select a second /tmp build route.
build=${QM_CORE_BUILD_ROOT:-${QM_SYSTEM_BUILD_ROOT:-$repo/temp/core-tools-build}}
out=${QM_OUTPUT_ROOT:-$repo/temp/core-tools-output}
jobs=${QM_JOBS:-$(nproc)}
mkdir -p "$upstream" "$build" "$out"

resolve_cc() {
  if [[ -n ${QM_SYSTEM_CC:-} ]]; then
    printf '%s\n' "$QM_SYSTEM_CC"
    return
  fi
  if command -v nix >/dev/null 2>&1; then
    local candidate
    while IFS= read -r candidate; do
      if [[ -x $candidate/bin/gcc ]]; then
        printf '%s\n' "$candidate/bin/gcc"
        return
      fi
    done < <(nix build --no-link --print-out-paths --no-write-lock-file \
      "path:$data/bootstrap#musl-gcc")
  fi
  command -v musl-gcc
}

resolve_build_tool() {
  local command_name=$1 attribute=$2 candidate
  if command -v "$command_name" >/dev/null 2>&1; then
    command -v "$command_name"
    return
  fi
  if command -v nix >/dev/null 2>&1; then
    while IFS= read -r candidate; do
      if [[ -x $candidate/bin/$command_name ]]; then
        printf '%s\n' "$candidate/bin/$command_name"
        return
      fi
    done < <(nix build --no-link --print-out-paths "$attribute")
  fi
  printf 'required build tool is unavailable: %s\n' "$command_name" >&2
  return 1
}

fetch() {
  local url=$1 target=$2 expected=$3
  if [[ ! -f $target ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$target.part" "$url"
    mv "$target.part" "$target"
  fi
  printf '%s  %s\n' "$expected" "$target" | sha256sum --check --status
}

extract_once() {
  local archive=$1 directory=$2
  if [[ ! -d $directory ]]; then
    tar -C "$build" --no-same-owner -xf "$archive"
  fi
}

cc=$(resolve_cc)
target=$($cc -dumpmachine)
case $target in
  x86_64-*-linux-musl) ;;
  *)
    printf 'core-tools compiler must target x86_64 Linux musl, got %s\n' \
      "$target" >&2
    exit 1
    ;;
esac
compiler_id=$($cc --version | sed -n '1p')
flex=$(resolve_build_tool flex "path:$data/bootstrap#flex")
bison=$(resolve_build_tool bison "path:$data/bootstrap#bison")
meson=$(resolve_build_tool meson "path:$data/bootstrap#meson")
ninja=$(resolve_build_tool ninja "path:$data/bootstrap#ninja")
flex_id=$($flex --version | sed -n '1p')
bison_id=$($bison --version | sed -n '1p')
meson_id=$($meson --version)
ninja_id=$($ninja --version)
build_tool_path=$(dirname -- "$flex"):$(dirname -- "$bison"):$(dirname -- "$meson"):$(dirname -- "$ninja"):$PATH

util_tar=$upstream/util-linux-$UTIL_LINUX_VERSION.tar.xz
kmod_tar=$upstream/kmod-$KMOD_VERSION.tar.xz
iproute_tar=$upstream/iproute2-$IPROUTE2_VERSION.tar.xz
fetch "$UTIL_LINUX_URL" "$util_tar" "$UTIL_LINUX_SHA256"
fetch "$KMOD_URL" "$kmod_tar" "$KMOD_SHA256"
fetch "$IPROUTE2_URL" "$iproute_tar" "$IPROUTE2_SHA256"

util_source=$build/util-linux-$UTIL_LINUX_VERSION
kmod_pristine=$build/kmod-$KMOD_VERSION
iproute_pristine=$build/iproute2-$IPROUTE2_VERSION
extract_once "$util_tar" "$util_source"
extract_once "$kmod_tar" "$kmod_pristine"
extract_once "$iproute_tar" "$iproute_pristine"

util_key=$(printf '%s\n' "$UTIL_LINUX_SHA256" "$compiler_id" \
  'util-linux-selected-all-static-v2' | sha256sum | cut -d' ' -f1)
kmod_key=$(printf '%s\n' "$KMOD_SHA256" "$compiler_id" \
  "$meson_id" "$ninja_id" \
  'kmod-tools-meson-internal-static-relocations-v4' | \
  sha256sum | cut -d' ' -f1)
iproute_key=$(printf '%s\n' "$IPROUTE2_SHA256" "$compiler_id" \
  "$flex_id" "$bison_id" 'iproute2-selected-static-v4' | \
  sha256sum | cut -d' ' -f1)
util_object=$build/packages/$util_key/object
util_root=$build/packages/$util_key/root
kmod_object=$build/packages/$kmod_key/object
kmod_root=$build/packages/$kmod_key/root
kmod_source=$build/packages/$kmod_key/source
iproute_source=$build/packages/$iproute_key/source
iproute_root=$build/packages/$iproute_key/root

if [[ ! -f $util_root/.complete ]]; then
  mkdir -p "$util_object" "$util_root"
  (
    cd "$util_object"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$util_source/configure" \
        --prefix=/usr --bindir=/usr/bin --sbindir=/usr/bin \
        --disable-shared --enable-static --disable-rpath \
        --enable-libuuid --enable-libblkid --enable-libmount \
        --enable-libsmartcols --enable-libfdisk \
        --disable-all-programs --enable-lsblk --enable-fdisks=check \
        --enable-blkid --enable-mount --enable-dmesg \
        --enable-static-programs=blkid,fdisk,mount,umount \
        --disable-nls --disable-widechar --disable-asciidoc \
        --disable-poman --disable-bash-completion \
        --disable-makeinstall-chown --disable-makeinstall-setuid \
        --disable-makeinstall-tty-setgid
  ) >&2
  make -C "$util_object" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    -j"$jobs" >&2
  make -C "$util_object" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    DESTDIR="$util_root" install >&2
  find "$util_root/usr/bin" -maxdepth 1 -type f \
    ! -name lsblk ! -name fdisk ! -name blkid ! -name mount \
    ! -name umount ! -name dmesg -delete
  rm -rf "$util_root/usr/include" "$util_root/usr/lib" \
    "$util_root/usr/share/man" "$util_root/usr/share/bash-completion"
  touch "$util_root/.complete"
fi

if [[ ! -f $kmod_root/.complete ]]; then
  if [[ ! -d $kmod_source ]]; then
    mkdir -p "$(dirname -- "$kmod_source")"
    cp -a "$kmod_pristine" "$kmod_source"
    patch -d "$kmod_source" -p1 < "$here/kmod-static-tools.patch"
  fi
  mkdir -p "$kmod_root"
  PATH="$build_tool_path" CC="$cc" CFLAGS='-O2 -std=gnu17' \
    "$meson" setup "$kmod_object" "$kmod_source" \
      --prefix=/usr --bindir=bin --sbindir=bin --libdir=lib \
      --sysconfdir=/etc --buildtype=release \
      -Dmanpages=false -Ddocs=false -Dbuild-tests=false \
      -Dlogging=false -Dzstd=disabled -Dxz=disabled -Dzlib=disabled \
      -Dopenssl=disabled -Ddlopen=[] >&2
  PATH="$build_tool_path" "$meson" compile -C "$kmod_object" \
    -j "$jobs" >&2
  DESTDIR="$kmod_root" PATH="$build_tool_path" \
    "$meson" install -C "$kmod_object" --no-rebuild >&2
  rm -rf "$kmod_root/usr/include" "$kmod_root/usr/lib" \
    "$kmod_root/usr/share"
  touch "$kmod_root/.complete"
fi

if [[ ! -f $iproute_root/.complete ]]; then
  mkdir -p "$(dirname -- "$iproute_source")"
  if [[ ! -d $iproute_source ]]; then
    cp -a "$iproute_pristine" "$iproute_source"
  fi
  mkdir -p "$iproute_root"
  (
    cd "$iproute_source"
    PATH="$build_tool_path" CC="$cc" AR=ar PKG_CONFIG=false \
      sh configure --include_dir "$iproute_source/include" \
        --libbpf_force off --prefix /usr --libdir /usr/lib
  ) >&2
  PATH="$build_tool_path" make -C "$iproute_source" \
    CC="$cc" HOSTCC="$cc" AR=ar PKG_CONFIG=false \
    SHARED_LIBS=n \
    LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    SUBDIRS='lib ip tc bridge misc' -j"$jobs" >&2
  PATH="$build_tool_path" make -C "$iproute_source" \
    CC="$cc" HOSTCC="$cc" AR=ar PKG_CONFIG=false \
    SHARED_LIBS=n \
    LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    SUBDIRS='lib ip tc bridge misc' DESTDIR="$iproute_root" \
    PREFIX=/usr SBINDIR=/usr/bin install >&2
  find "$iproute_root/usr/bin" -maxdepth 1 -type f \
    ! -name ip ! -name tc ! -name bridge ! -name ss -delete
  # These compatibility aliases target lnstat, which is intentionally outside
  # the selected runtime.  A closed release does not publish dangling names.
  rm -f "$iproute_root/usr/bin/ctstat" "$iproute_root/usr/bin/rtstat"
  rm -rf "$iproute_root/usr/include" "$iproute_root/usr/share/man" \
    "$iproute_root/usr/share/bash-completion"
  touch "$iproute_root/.complete"
fi

recipe_key=$(printf '%s\n' "$util_key" "$kmod_key" "$iproute_key" | \
  sha256sum | cut -d' ' -f1)
publication_key=$(printf '%s\n' "$recipe_key" \
  'component-linked-core-tools-package-set-v3' | \
  sha256sum | cut -d' ' -f1)
publication=$build/$publication_key
candidate=$publication/root.partial
root=$publication/root
prepared_root=$publication/packages
package_specs=(
  "util-linux:$util_root" "kmod:$kmod_root" "iproute2:$iproute_root"
)

if [[ ! -f $publication/.complete ]]; then
  if [[ -e $candidate || -e $root || -e $prepared_root ]]; then
    printf 'incomplete core-tools publication exists: %s\n' \
      "$publication" >&2
    exit 1
  fi
  mkdir -p "$publication" "$candidate" "$prepared_root"
  for specification in "${package_specs[@]}"; do
    name=${specification%%:*}
    package_root=${specification#*:}
    prepared=$prepared_root/$name
    bash "$here/clone-tree.sh" "$package_root" "$prepared"
    find "$prepared" -name .complete -delete
    bash "$here/clone-tree.sh" "$prepared" "$candidate"
  done
  mv -- "$candidate" "$root"
  touch "$publication/.complete"
fi

required=(
  usr/bin/mount usr/bin/umount usr/bin/dmesg
  usr/bin/lsblk usr/bin/fdisk usr/bin/blkid
  usr/bin/kmod usr/bin/modprobe usr/bin/insmod usr/bin/rmmod usr/bin/lsmod
  usr/bin/ip usr/bin/tc usr/bin/bridge usr/bin/ss
)
for path in "${required[@]}"; do
  if [[ ! -x $root/$path ]]; then
    printf 'core-tools path is missing: /%s\n' "$path" >&2
    exit 1
  fi
done

package_outputs=()
for specification in "${package_specs[@]}"; do
  name=${specification%%:*}
  package_outputs+=("$name:$prepared_root/$name")
done
bash "$here/emit-package-set.sh" "$out" \
  x86_64-linux-musl-core-tools "$publication_key" \
  "${package_outputs[@]}" >&3
