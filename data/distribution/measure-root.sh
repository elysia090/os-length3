#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if (( $# < 1 || $# > 2 )); then
  printf 'usage: %s ROOT [REPORT]\n' "$0" >&2
  exit 2
fi

root=${1%/}
report=${2:-/dev/stdout}
if [[ ! -d $root ]]; then
  printf 'release root does not exist: %s\n' "$root" >&2
  exit 2
fi

# Exact logical release population.  Equal file payloads are charged once, but
# the canonical inode/path graph, symlink payloads and xattrs are charged as
# well.  The canonical spelling used for this measurement is deliberately
# simple and self-delimiting:
#
#   32-byte root header
#   object: digest32 || extent64 || payload
#   inode:  kind8 || mode32 || uid32 || gid32 || kind payload
#   path:   extent64 || path bytes || inode-rank32
#   xattr:  inode-rank32 || name-extent32 || name || value-extent64 || value
#
# File inodes name their object by digest32. Directories have no kind payload;
# symlinks carry extent64 plus target bytes; special nodes carry rdev64. Inode
# ranks are assigned canonically by path order by the Artifact writer, but their
# fixed width makes this byte measurement independent of traversal order.
# Storage compression/encryption/ECC are a later projection and are reported
# separately; they never replace this number.
declare -A seen_inode=()
declare -A seen_digest=()
declare -A path_inode=()
regular_paths=0
regular_inodes=0
regular_objects=0
logical_file_bytes=0
inode_file_bytes=0
canonical_payload_bytes=0
name_bytes=0
directories=0
symlinks=0
symlink_payload_bytes=0
specials=0
canonical_object_metadata_bytes=0
canonical_inode_bytes=0
canonical_path_bytes=0
xattr_records=0
canonical_xattr_bytes=0
while IFS= read -r -d '' kind \
    && IFS= read -r -d '' size \
    && IFS= read -r -d '' inode \
    && IFS= read -r -d '' path \
    && IFS= read -r -d '' target; do
  if [[ $path == "$root" ]]; then relative=; else relative=${path#"$root"/}; fi
  if [[ $relative == *$'\n'* || $relative == *$'\r'* ]]; then
    printf 'release path is not representable by the measurement contract: %q\n' \
      "$relative" >&2
    exit 1
  fi
  path_inode[$path]=$inode
  name=${relative##*/}
  canonical_path_bytes=$((canonical_path_bytes + 8 + ${#relative} + 4))
  if [[ $path != "$root" ]]; then
    name_bytes=$((name_bytes + ${#name}))
  fi
  if [[ -n ${seen_inode[$inode]+present} ]]; then
    if [[ $kind == f ]]; then
      regular_paths=$((regular_paths + 1))
      logical_file_bytes=$((logical_file_bytes + size))
    fi
    continue
  fi
  seen_inode[$inode]=1
  case $kind in
    f)
      regular_paths=$((regular_paths + 1))
      logical_file_bytes=$((logical_file_bytes + size))
      regular_inodes=$((regular_inodes + 1))
      inode_file_bytes=$((inode_file_bytes + size))
      canonical_inode_bytes=$((canonical_inode_bytes + 1 + 4 + 4 + 4 + 32))
      digest=$(sha256sum "$path" | cut -d' ' -f1)
      if [[ -z ${seen_digest[$digest]+present} ]]; then
        seen_digest[$digest]=1
        regular_objects=$((regular_objects + 1))
        canonical_payload_bytes=$((canonical_payload_bytes + size))
        canonical_object_metadata_bytes=$((canonical_object_metadata_bytes + 32 + 8))
      fi
      ;;
    d)
      directories=$((directories + 1))
      canonical_inode_bytes=$((canonical_inode_bytes + 1 + 4 + 4 + 4))
      ;;
    l)
      symlinks=$((symlinks + 1))
      symlink_payload_bytes=$((symlink_payload_bytes + ${#target}))
      canonical_inode_bytes=$((canonical_inode_bytes + 1 + 4 + 4 + 4 + 8 + ${#target}))
      ;;
    *)
      specials=$((specials + 1))
      canonical_inode_bytes=$((canonical_inode_bytes + 1 + 4 + 4 + 4 + 8))
      ;;
  esac
done < <(find "$root" -printf '%y\0%s\0%D:%i\0%p\0%l\0')

# Query xattr extents directly. No hex expansion or value buffer is necessary
# to measure canonical bytes, and attribute CLI packages are not build inputs.
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_root=$here/../../temp/distribution-tools
tool_key=$(sha256sum "$here/measure-xattrs.c" | cut -d' ' -f1)
xattr_tool=$tool_root/measure-xattrs-$tool_key
if [[ ! -x $xattr_tool ]]; then
  mkdir -p "$tool_root"
  "${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror \
    "$here/measure-xattrs.c" -o "$xattr_tool.partial.$$"
  mv -- "$xattr_tool.partial.$$" "$xattr_tool"
fi
declare -A seen_xattr_inode=()
exec {xattr_fd}< <("$xattr_tool" "$root")
xattr_pid=$!
while IFS= read -r -d '' xattr_path \
    && IFS= read -r -d '' records \
    && IFS= read -r -d '' bytes; do
  current_xattr_inode=${path_inode[$xattr_path]-}
  if [[ -z $current_xattr_inode || ! $records =~ ^[0-9]+$ || ! $bytes =~ ^[0-9]+$ ]]; then
    printf 'invalid xattr extent row for release path: %q\n' "$xattr_path" >&2
    exit 1
  fi
  [[ -z ${seen_xattr_inode[$current_xattr_inode]+present} ]] || continue
  seen_xattr_inode[$current_xattr_inode]=1
  xattr_records=$((xattr_records + records))
  canonical_xattr_bytes=$((canonical_xattr_bytes + bytes))
done <&"$xattr_fd"
exec {xattr_fd}<&-
wait "$xattr_pid"

canonical_filesystem_bytes=$((32 + canonical_payload_bytes \
  + canonical_object_metadata_bytes + canonical_inode_bytes \
  + canonical_path_bytes + canonical_xattr_bytes))

temporary="$report.partial.$$"
if [[ $report == /dev/stdout ]]; then
  temporary=$report
fi
{
  printf 'format=canonical-filesystem-population-v1\n'
  printf 'regular_paths=%u\n' "$regular_paths"
  printf 'regular_inodes=%u\n' "$regular_inodes"
  printf 'regular_objects=%u\n' "$regular_objects"
  printf 'hardlink_aliases=%u\n' "$((regular_paths - regular_inodes))"
  printf 'content_aliases=%u\n' "$((regular_inodes - regular_objects))"
  printf 'logical_file_bytes=%u\n' "$logical_file_bytes"
  printf 'inode_file_bytes=%u\n' "$inode_file_bytes"
  printf 'digest_reads=%u\n' "$regular_inodes"
  printf 'digest_input_bytes=%u\n' "$inode_file_bytes"
  printf 'canonical_payload_bytes=%u\n' "$canonical_payload_bytes"
  printf 'canonical_object_metadata_bytes=%u\n' \
    "$canonical_object_metadata_bytes"
  printf 'canonical_inode_bytes=%u\n' "$canonical_inode_bytes"
  printf 'canonical_path_bytes=%u\n' "$canonical_path_bytes"
  printf 'xattr_records=%u\n' "$xattr_records"
  printf 'canonical_xattr_bytes=%u\n' "$canonical_xattr_bytes"
  printf 'canonical_filesystem_bytes=%u\n' "$canonical_filesystem_bytes"
  printf 'tree_traversals=2\n'
  printf 'digest_payload_reads=%u\n' "$regular_inodes"
  printf 'directories=%u\n' "$directories"
  printf 'symlinks=%u\n' "$symlinks"
  printf 'specials=%u\n' "$specials"
  printf 'name_bytes=%u\n' "$name_bytes"
  printf 'symlink_payload_bytes=%u\n' "$symlink_payload_bytes"
} >"$temporary"
if [[ $report != /dev/stdout ]]; then
  mv -- "$temporary" "$report"
fi
