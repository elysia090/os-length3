#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  printf 'usage: %s SOURCE DESTINATION [REGULAR-FILE-LIST]\n' "$0" >&2
  exit 2
fi

source_argument=$1
destination_argument=$2
regular_list=${3:-}
if [[ ! -d $source_argument ]]; then
  printf 'tree clone source is not a directory: %s\n' "$source_argument" >&2
  exit 2
fi

source_tree=$(cd -- "$source_argument" && pwd -P)
mkdir -p "$destination_argument"
destination=$(cd -- "$destination_argument" && pwd -P)
if [[ $destination == "$source_tree" || $destination == "$source_tree"/* ]]; then
  printf 'tree clone destination is inside its source: %s\n' "$destination" >&2
  exit 2
fi
if [[ $(stat -c %d -- "$source_tree") != $(stat -c %d -- "$destination") ]]; then
  printf 'tree clone requires one filesystem: %s -> %s\n' \
    "$source_tree" "$destination" >&2
  exit 2
fi
# A fresh destination owns one independent copy of each source inode while
# preserving aliases inside that destination.  Do not hard-link it back to the
# source tree: doing so couples checkpoint lifetimes and eventually exhausts a
# finite filesystem link count when the same package is projected repeatedly.
# `cp -a` preserves the source inode relation within the new tree; reflink is a
# zero-copy optimization where the filesystem supports it and an ordinary
# streaming copy elsewhere.
#
# A release root, however, is the disjoint union of several package roots. For
# later roots, first prove that every already-present coordinate has the same
# type, mode, link target and bytes, then add only absent coordinates as hard
# links to their sole owner. Thus merge order cannot overwrite a package and no
# payload copy is opened.
if [[ -z $(find "$destination" -mindepth 1 -print -quit) ]]; then
  cp -a --reflink=auto "$source_tree/." "$destination/"
else
  if ! command -v rsync >/dev/null 2>&1; then
    printf 'tree merge requires rsync\n' >&2
    exit 2
  fi
  conflicts=$(mktemp)
  cleanup() { rm -f -- "$conflicts"; }
  trap cleanup EXIT HUP INT TERM
  rsync --recursive --links --perms --devices --specials --checksum \
    --dry-run --existing --itemize-changes --out-format='%i %n%L' \
    "$source_tree/" "$destination/" >"$conflicts"
  if [[ -s $conflicts ]]; then
    printf 'tree merge has conflicting package coordinates:\n' >&2
    sed -n '1,20p' "$conflicts" >&2
    exit 2
  fi
  # Neither rsync --link-dest nor cp -aln has the right no-follow behavior for
  # an already-present symlink whose target is a directory (s6-rc emits these).
  # Select absent coordinates before cpio sees them.  The stream is NUL-safe,
  # keeps no pathname population in memory, preserves entry types, and lets
  # cpio hard-link each new regular payload to its sole package owner.
  (
    cd -- "$source_tree"
    find . -print0 |
      while IFS= read -r -d '' path; do
        if [[ ! -e "$destination/$path" && ! -L "$destination/$path" ]]; then
          printf '%s\0' "$path"
        fi
      done |
      cpio --null --pass-through --make-directories --link \
        --preserve-modification-time --quiet "$destination"
  )
  cleanup
  trap - EXIT HUP INT TERM
fi

if [[ -n $regular_list ]]; then
  # The sole metadata scan emits the physical columns consumed by the next
  # stage.  `%p` remains absolute because the find root is absolute.
  find "$source_tree" -type f -printf '%p\0%D:%i\0%s\0' >"$regular_list"
fi
