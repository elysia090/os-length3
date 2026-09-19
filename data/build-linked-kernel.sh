#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
target=${1:-vmlinux}
case $target in
  vmlinux|bzImage) ;;
  *) printf 'usage: %s [vmlinux|bzImage]\n' "$0" >&2; exit 2;;
esac

. "$here/bootstrap/environment.sh"
. "$here/sources.env"

upstream="$here/upstream"
archive="$upstream/linux-$LINUX_VERSION.tar.xz"
root=${QM_LINKED_KERNEL_ROOT:-${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}/libqm-linked-kernel-$LINUX_VERSION}
source_root="$root/source"
source_stage="$root/source.extracting"
source_stamp="$root/source-$LINUX_SHA256.complete"
output_root="$root/output/$QM_BOOTSTRAP_ID"
config_lock="$here/config/linux-$LINUX_VERSION.config"

if [[ ! -f $archive ]]; then
  printf 'missing locked Linux source: %s\n' "$archive" >&2
  exit 2
fi
printf '%s  %s\n' "$LINUX_SHA256" "$archive" |
  sha256sum --check --status

for command in make gcc ld flex bison bc perl pkg-config pahole; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'missing linked-kernel build command: %s\n' "$command" >&2
    exit 2
  fi
done
if ! pkg-config --exists libelf; then
  printf 'missing linked-kernel build dependency: libelf.pc\n' >&2
  exit 2
fi

mkdir -p "$root"
source_complete() {
  test -f "$source_root/Makefile" \
    && test -f "$source_root/scripts/Kbuild.include" \
    && test -f "$source_root/arch/x86/include/uapi/asm/bitsperlong.h" \
    && test -f "$source_root/init/main.c" \
    && test -f "$source_root/net/ipv4/ip_input.c"
}
if [[ -f $source_stamp ]] && ! source_complete; then
  # A stale marker must never turn a reclaimed or partially materialized
  # source tree into a valid build checkpoint.  These witnesses span early
  # metadata, the target UAPI, init and a late network subtree.
  rm -f -- "$source_stamp"
fi
if [[ ! -f $source_stamp ]]; then
  # A top-level Makefile appears near the start of the tar stream, so it is
  # not evidence that a prior extraction completed.  Extract transactionally
  # and publish a digest-bound marker only after late build inputs exist.
  rm -rf -- "$source_stage" "$source_root"
  mkdir -p "$source_stage"
  tar -C "$source_stage" --no-same-owner --strip-components=1 -xf "$archive"
  test -f "$source_stage/Makefile"
  test -f "$source_stage/scripts/Kbuild.include"
  test -f "$source_stage/arch/x86/include/uapi/asm/bitsperlong.h"
  test -f "$source_stage/init/main.c"
  test -f "$source_stage/net/ipv4/ip_input.c"
  mv -- "$source_stage" "$source_root"
  printf '%s\n' "$LINUX_SHA256" >"$source_stamp.tmp"
  mv -- "$source_stamp.tmp" "$source_stamp"
fi
source_complete
mkdir -p "$output_root"

# One builder owns both the linked ELF and its x86 boot wrapper. Regenerate
# the fragment and compare the resolved lock before reusing Kbuild objects;
# the distribution must not create a second kernel tree to reach bzImage.
make -C "$source_root" O="$output_root" ARCH=x86_64 allnoconfig
while IFS= read -r option; do
  key=${option%%=*}
  symbol=${key#CONFIG_}
  case $option in
    CONFIG_*=y) "$source_root/scripts/config" --file "$output_root/.config" --enable "$symbol";;
    CONFIG_*=n) "$source_root/scripts/config" --file "$output_root/.config" --disable "$symbol";;
  esac
done < "$here/config/linux.fragment"
make -C "$source_root" O="$output_root" ARCH=x86_64 olddefconfig
if ! cmp -s "$output_root/.config" "$config_lock"; then
  printf 'resolved linked-kernel config differs from lock: %s\n' \
    "$config_lock" >&2
  diff -u "$config_lock" "$output_root/.config" || true
  exit 1
fi

make -C "$source_root" O="$output_root" ARCH=x86_64 \
  -j"${QM_JOBS:-$(nproc)}" \
  CONFIG_ARCH_VMLINUX_NEEDS_RELOCS=y "$target"

vmlinux="$output_root/vmlinux.unstripped"
test -f "$vmlinux"
# `grep -q` closes the pipe at the first match; under pipefail that turns
# readelf's expected SIGPIPE into a false negative.  Consume the full table.
if ! readelf -SW "$vmlinux" | grep '[.]rela[.]' >/dev/null; then
  printf 'linked kernel lacks static construction relocations: %s\n' \
    "$vmlinux" >&2
  exit 1
fi
while read -r alignment; do
  if (( alignment % 0x200000 != 0 )); then
    printf 'linked kernel PT_LOAD alignment is not 2 MiB: %s\n' \
      "$alignment" >&2
    exit 1
  fi
done < <(readelf -lW "$vmlinux" | awk '$1 == "LOAD" { print $NF }')
printf 'linked-kernel=%s\n' "$vmlinux"
printf 'linked-kernel-bytes=%s\n' "$(stat -c %s "$vmlinux")"
printf 'linked-kernel-sha256=%s\n' \
  "$(sha256sum "$vmlinux" | cut -d' ' -f1)"
