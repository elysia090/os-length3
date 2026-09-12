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

# `-e hex` makes value extent mechanical.  The recursive dump is one bounded
# pass, and the first canonical path for an inode owns its xattr rows.  A later
# hard-link spelling is ignored, so one inode is neither hidden nor charged
# twice.  An unknown path or representation is a hard error.
if ! command -v getfattr >/dev/null; then
  printf 'canonical release measurement requires getfattr\n' >&2
  exit 1
fi
declare -A seen_xattr_inode=()
current_xattr_inode=
accept_xattr=0
while IFS= read -r attribute; do
  case $attribute in
    '# file: '*)
      xattr_path=${attribute#'# file: '}
      current_xattr_inode=${path_inode[$xattr_path]-}
      if [[ -z $current_xattr_inode ]]; then
        printf 'xattr walk returned an unknown release path: %q\n' \
          "$xattr_path" >&2
        exit 1
      fi
      if [[ -n ${seen_xattr_inode[$current_xattr_inode]+present} ]]; then
        accept_xattr=0
      else
        seen_xattr_inode[$current_xattr_inode]=1
        accept_xattr=1
      fi
      continue
      ;;
    '')
      current_xattr_inode=
      accept_xattr=0
      continue
      ;;
  esac
  [[ $attribute == *=* ]] || continue
  if [[ -z $current_xattr_inode ]]; then
    printf 'xattr row has no owning release path: %s\n' "$attribute" >&2
    exit 1
  fi
  (( accept_xattr != 0 )) || continue
  xattr_name=${attribute%%=*}
  encoded=${attribute#*=}
  if [[ $encoded != 0x* || ${#encoded} -lt 2 \
      || $(((${#encoded} - 2) % 2)) -ne 0 ]]; then
    printf 'noncanonical xattr representation: %s\n' "$attribute" >&2
    exit 1
  fi
  value_bytes=$(((${#encoded} - 2) / 2))
  xattr_records=$((xattr_records + 1))
  canonical_xattr_bytes=$((canonical_xattr_bytes + 4 + 4 \
    + ${#xattr_name} + 8 + value_bytes))
done < <(getfattr -R -h --absolute-names -d -m - -e hex -- "$root" 2>/dev/null)

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
