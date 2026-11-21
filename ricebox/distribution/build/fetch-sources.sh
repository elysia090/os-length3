#!/bin/sh
# GNU recommends its mirror selector: https://www.gnu.org/prep/ftp.html . The fixed HTTPS mirror there is a
# second route if the selector or its chosen mirror is away; the original URL is still tried last. Keep the
# path and the pin exactly as given (including bash's patch directories).
source_urls() {
  case $1 in
    https://ftp.gnu.org/gnu/*)
      printf '%s\n' "https://ftpmirror.gnu.org/${1#https://ftp.gnu.org/gnu/}" \
        "https://mirror.csclub.uwaterloo.ca/gnu/${1#https://ftp.gnu.org/gnu/}" ;;
  esac
  printf '%s\n' "$1"
  case $1 in
    https://download.samba.org/pub/rsync/src/rsync-3.5.2.tar.gz)
      # The project's uploaded release tarball has the same pin, not the generated tag archive.
      printf '%s\n' 'https://github.com/RsyncProject/rsync/releases/download/v3.5.2/rsync-3.5.2.tar.gz' ;;
  esac
}

# URL FILE DIGEST ALGORITHM: only a complete download with the pinned digest replaces FILE. curl writes to a
# file so its retries can truncate a partial response; failed downloads and bad digests never enter the cache.
fetch_source() (
  url=$1; file=$2; sum=$3; alg=$4
  echo "$sum  $file" | "${alg}sum" -c - >/dev/null 2>&1 && exit 0
  trap 'rm -f "$file.part"' EXIT
  for at in $(source_urls "$url"); do
    for attempt in 1 2 3; do
      if ! curl -fsSL --connect-timeout 20 --max-time 600 --speed-limit 1024 --speed-time 30 \
          --retry 2 --retry-delay 5 --retry-max-time 120 -o "$file.part" "$at"; then
        echo "root-fetch: $at: download failed" >&2
        break
      fi
      if echo "$sum  $file.part" | "${alg}sum" -c - >/dev/null 2>&1; then
        mv "$file.part" "$file" || exit 1
        exit 0
      fi
      echo "root-fetch: $at: not the pinned $alg digest (attempt $attempt)" >&2
      [ "$attempt" = 3 ] || sleep 5
    done
  done
  echo "root-fetch: cannot obtain the file pinned at $url" >&2
  exit 1
)
