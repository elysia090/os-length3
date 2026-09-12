#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

root=$temporary/root
mkdir -p "$root/boot" "$root/usr/bin"
printf kernel >"$root/boot/kernel"
printf initramfs >"$root/boot/initramfs"
printf abc >"$root/usr/bin/tool"
ln "$root/usr/bin/tool" "$root/usr/bin/tool-hard"
cp "$root/usr/bin/tool" "$root/usr/bin/tool-copy"
ln -s usr/bin/tool "$root/tool-link"
setfattr -n user.contract -v 0x0102 "$root/usr/bin/tool"

report=$temporary/population
bash "$here/measure-root.sh" "$root" "$report"

expect() {
  local field=$1 value=$2 actual
  actual=$(sed -n "s/^${field}=//p" "$report")
  if [[ $actual != "$value" ]]; then
    printf 'canonical root field differs: %s=%s, expected %s\n' \
      "$field" "$actual" "$value" >&2
    exit 1
  fi
}

expect format canonical-filesystem-population-v1
expect regular_paths 5
expect regular_inodes 4
expect regular_objects 3
expect hardlink_aliases 1
expect content_aliases 1
expect logical_file_bytes 24
expect inode_file_bytes 21
expect canonical_payload_bytes 18
expect canonical_object_metadata_bytes 120
expect canonical_inode_bytes 265
expect canonical_path_bytes 214
expect xattr_records 1
expect canonical_xattr_bytes 31
expect canonical_filesystem_bytes 680
expect directories 4
expect symlinks 1
expect specials 0
expect tree_traversals 2

# The build marker is state outside the immutable release root.  Including it
# must be observable rather than silently excluded by the population reader.
touch "$root/.complete"
bash "$here/measure-root.sh" "$root" "$temporary/with-marker"
marker_bytes=$(sed -n 's/^canonical_filesystem_bytes=//p' \
  "$temporary/with-marker")
if [[ ! $marker_bytes =~ ^[0-9]+$ ]] || (( marker_bytes <= 680 )); then
  printf 'canonical root measurement hid an injected build marker\n' >&2
  exit 1
fi

printf 'canonical release population: green (payload, boot, graph, xattr)\n'
