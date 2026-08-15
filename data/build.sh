#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$here/.." && pwd)
. "$here/sources.env"

upstream="$here/upstream"
# WSL's /mnt/c metadata path is much slower for kernel trees. Keep the source
# lock under data/, but allow disposable expansion on the native Linux volume.
build=${QM_BUILD_ROOT:-${TMPDIR:-/tmp}/libqm-linux-build}
out=${QM_OUTPUT_ROOT:-${TMPDIR:-/tmp}/libqm-linux-output}
mkdir -p "$upstream" "$build" "$out"

fetch() {
  local url=$1 output=$2 expected=$3
  if [[ ! -f "$output" ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$output.part" "$url"
    mv "$output.part" "$output"
  fi
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status
}

apply_config_fragment() {
  local config=$1 fragment=$2 line key value
  while IFS= read -r line; do
    case $line in
      CONFIG_*=y|CONFIG_*=n)
        key=${line%%=*}
        value=${line#*=}
        sed -i -e "/^${key}=/d" -e "/^# ${key} is not set$/d" "$config"
        if [[ $value == y ]]; then
          printf '%s=y\n' "$key" >> "$config"
        else
          printf '# %s is not set\n' "$key" >> "$config"
        fi
        ;;
    esac
  done < "$fragment"
}

resolve_busybox_cc() {
  if [[ -n ${QM_BUSYBOX_CC:-} ]]; then
    printf '%s\n' "$QM_BUSYBOX_CC"
    return
  fi
  if command -v nix >/dev/null 2>&1; then
    local candidate
    while IFS= read -r candidate; do
      if [[ -x $candidate/bin/gcc ]]; then
        printf '%s\n' "$candidate/bin/gcc"
        return
      fi
    done < <(nix build --no-link --print-out-paths nixpkgs#pkgsMusl.gcc)
  fi
  command -v gcc
}

ensure_libelf_pkg_config() {
  if pkg-config --exists libelf; then
    return
  fi
  if command -v nix >/dev/null 2>&1; then
    local elfutils_dev
    elfutils_dev=$(nix build --no-link --print-out-paths nixpkgs#elfutils.dev)
    export PKG_CONFIG_PATH="$elfutils_dev/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  fi
  pkg-config --exists libelf
}

verify_config_lock() {
  local generated=$1 locked=$2
  if [[ ! -f $locked ]]; then
    printf 'missing resolved config lock: %s\n' "$locked" >&2
    return 1
  fi
  if ! cmp -s "$generated" "$locked"; then
    printf 'resolved config differs from lock: %s\n' "$locked" >&2
    diff -u "$locked" "$generated" || true
    return 1
  fi
}

linux_tar="$upstream/linux-$LINUX_VERSION.tar.xz"
busybox_tar="$upstream/busybox-$BUSYBOX_VERSION.tar.bz2"
make_tar="$upstream/make-$MAKE_VERSION.tar.gz"
fetch "$LINUX_URL" "$linux_tar" "$LINUX_SHA256"
fetch "$BUSYBOX_URL" "$busybox_tar" "$BUSYBOX_SHA256"
fetch "$MAKE_URL" "$make_tar" "$MAKE_SHA256"

linux_src="$build/linux-$LINUX_VERSION"
busybox_src="$build/busybox-$BUSYBOX_VERSION"
make_src="$build/make-$MAKE_VERSION"
if [[ ! -d "$linux_src" ]]; then
  tar -C "$build" -xf "$linux_tar"
fi
if [[ ! -d "$busybox_src" ]]; then
  tar -C "$build" -xf "$busybox_tar"
fi
if [[ ! -d "$make_src" ]]; then
  tar -C "$build" -xf "$make_tar"
fi

busybox_o="$busybox_src"
busybox_root="$build/busybox-root"
busybox_cc=$(resolve_busybox_cc)
busybox_stamp="$busybox_src/.qm-build"
busybox_key=$(
  {
    sha256sum "$here/config/busybox.fragment"
    "$busybox_cc" --version | sed -n '1p'
  } | sha256sum | cut -d' ' -f1
)
if [[ ! -x $busybox_root/bin/busybox ]] || \
   [[ ! -f $busybox_stamp ]] || \
   [[ $(<"$busybox_stamp") != "$busybox_key" ]]; then
  make -C "$busybox_src" distclean
  make -C "$busybox_src" allnoconfig
  apply_config_fragment "$busybox_src/.config" "$here/config/busybox.fragment"
  make -C "$busybox_src" oldconfig </dev/null
  make -C "$busybox_src" CC="$busybox_cc" -j"$(nproc)"
  make -C "$busybox_src" CC="$busybox_cc" \
    CONFIG_PREFIX="$busybox_root" install
  printf '%s\n' "$busybox_key" > "$busybox_stamp"
fi
verify_config_lock "$busybox_src/.config" \
  "$here/config/busybox-$BUSYBOX_VERSION.config"
install -D -m 0755 "$here/initramfs/init" "$busybox_root/init"
install -d -m 0755 "$busybox_root/dev" "$busybox_root/proc" \
  "$busybox_root/sys"
install -d -m 1777 "$busybox_root/tmp"

# GNU make is the first deliberately non-BusyBox guest tool.  Build it from a
# pinned upstream tarball with the same static musl compiler as BusyBox so the
# initramfs never depends on a Nix store path or a guest dynamic loader.
make_root="$build/make-root"
make_bin="$make_root/bin/make"
make_stamp="$make_src/.qm-build"
make_key=$(
  {
    printf '%s\n' "$MAKE_SHA256"
    printf '%s\n' 'gnu17-static-v1'
    "$busybox_cc" --version | sed -n '1p'
  } | sha256sum | cut -d' ' -f1
)
if [[ ! -x $make_bin ]] || [[ ! -f $make_stamp ]] || \
   [[ $(<"$make_stamp") != "$make_key" ]]; then
  if [[ -f $make_src/Makefile ]]; then
    make -C "$make_src" distclean
  fi
  (
    cd "$make_src"
    CC="$busybox_cc" CFLAGS='-O2 -static -std=gnu17' LDFLAGS='-static' \
      ./configure --prefix="$make_root" --disable-nls
    make -j"$(nproc)"
    make install
  )
  printf '%s\n' "$make_key" > "$make_stamp"
fi
install -D -m 0755 "$make_bin" "$busybox_root/bin/make"
install -D -m 0644 "$here/bootstrap/Makefile" \
  "$busybox_root/opt/qm/Makefile"

linux_o="$build/linux-out"
mkdir -p "$linux_o"
ensure_libelf_pkg_config
make -C "$linux_src" O="$linux_o" ARCH=x86_64 allnoconfig
while IFS= read -r option; do
  key=${option%%=*}
  symbol=${key#CONFIG_}
  case $option in
    CONFIG_*=y)
      "$linux_src/scripts/config" --file "$linux_o/.config" \
        --enable "$symbol" ;;
    CONFIG_*=n)
      "$linux_src/scripts/config" --file "$linux_o/.config" \
        --disable "$symbol" ;;
  esac
done < "$here/config/linux.fragment"
make -C "$linux_src" O="$linux_o" ARCH=x86_64 olddefconfig
verify_config_lock "$linux_o/.config" \
  "$here/config/linux-$LINUX_VERSION.config"
make -C "$linux_src" O="$linux_o" ARCH=x86_64 -j"$(nproc)" bzImage

initramfs="$out/busybox-$BUSYBOX_VERSION.cpio"
(
  cd "$busybox_root"
  find . -print0 | sort -z | cpio --null -o --format=newc \
    --owner=0:0 --reproducible > "$initramfs"
)

command_line='console=ttyS0 earlycon=uart,io,0x3f8,115200n8 nokaslr rdinit=/init panic=-1 noapic nolapic acpi=off nosmp tsc=reliable'
cd "$repo/src/v2"
PYTHONPATH=. python3 tools/build_x86_boot_cache.py \
  "$linux_o/arch/x86/boot/bzImage" \
  "$out/linux-x86-64.boot" \
  --memory-mib 128 --command-line "$command_line" \
  --initrd "$initramfs" \
  --artifact-root "$repo/artifact" \
  --artifact-name linux-x86-64 --replace-artifact
