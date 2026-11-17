#!/bin/sh
# Exercise the builder's actual downloader without public network access or time spent on retries.
set -eu
. "$(dirname "$0")/../fetch-sources.sh"
work=$(mktemp -d)
trap 'rm -f "$work/file" "$work/file.part" "$work/calls"; rmdir "$work"' EXIT
sleep() { :; }
good='the exact archive pinned'
sum=$(printf '%s' "$good" | sha256sum | cut -d' ' -f1)
url=https://ftp.gnu.org/gnu/ncurses/ncurses-6.6.tar.gz
mirror=https://mirror.csclub.uwaterloo.ca/gnu/ncurses/ncurses-6.6.tar.gz
curl() {
  output=
  while [ "$#" -gt 0 ]; do
    case $1 in -o) output=$2; shift ;; esac
    at=$1; shift
  done
  printf '%s\n' "$at" >> "$work/calls"
  case $mode in
    offline) return 28 ;;
    bad) printf 'wrong archive' > "$output" ;;
    partial)
      if [ "$at" != "$mirror" ]; then printf 'partial' > "$output"; return 18; fi
      printf '%s' "$good" > "$output" ;;
    corrupt)
      if [ "$at" != "$mirror" ]; then printf 'wrong archive' > "$output"; else printf '%s' "$good" > "$output"; fi ;;
    original)
      [ "$at" = "$url" ] || return 22
      printf '%s' "$good" > "$output" ;;
    good) printf '%s' "$good" > "$output" ;;
  esac
}
reset() { rm -f "$work/file" "$work/file.part"; : > "$work/calls"; }

# A directory and its query keep their complete path; unrelated hosts are never rewritten.
[ "$(source_urls https://ftp.gnu.org/gnu/bash/bash-5.3-patches/ | head -n 1)" = https://ftpmirror.gnu.org/bash/bash-5.3-patches/ ]
[ "$(source_urls 'https://ftp.gnu.org/gnu/bash/?x=1' | tail -n 1)" = 'https://ftp.gnu.org/gnu/bash/?x=1' ]
[ "$(source_urls https://ftp.gnu.org.example/gnu/file)" = https://ftp.gnu.org.example/gnu/file ]

for mode in partial corrupt original; do
  reset
  fetch_source "$url" "$work/file" "$sum" sha256
  [ "$(cat "$work/file")" = "$good" ]
  [ ! -e "$work/file.part" ]
  case $mode in
    partial) [ "$(wc -l < "$work/calls")" -eq 2 ] ;;
    corrupt) [ "$(wc -l < "$work/calls")" -eq 4 ] ;;
    original) [ "$(tail -n 1 "$work/calls")" = "$url" ] ;;
  esac
done

# A checked cache is used without a request. Both supported digest algorithms are enforced.
: > "$work/calls"
mode=offline
fetch_source "$url" "$work/file" "$sum" sha256
[ ! -s "$work/calls" ]
reset
mode=good
sum512=$(printf '%s' "$good" | sha512sum | cut -d' ' -f1)
fetch_source https://example.org/file "$work/file" "$sum512" sha512
[ "$(cat "$work/calls")" = https://example.org/file ]

for mode in offline bad; do
  reset
  printf 'old invalid cache' > "$work/file"
  printf 'old partial' > "$work/file.part"
  if fetch_source "$url" "$work/file" "$sum" sha256; then echo "accepted $mode" >&2; exit 1; fi
  [ "$(cat "$work/file")" = 'old invalid cache' ]
  [ ! -e "$work/file.part" ]
  grep -Fx "$url" "$work/calls" >/dev/null
done
echo 'source fallback, partial transfers, cache and digest checks passed'
