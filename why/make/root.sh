#!/bin/sh
# why's composition of ricebox: the product command and shell policy are additions,
# not dependencies of the distributor. Existing why releases retain their names.
# sh why/make/root.sh PACKAGES OUT VERSION
set -eu
[ "$#" -eq 3 ] || { echo 'usage: root.sh PACKAGES OUT VERSION' >&2; exit 2; }
pkgs=$(cd "$1" && pwd); out=$2; version=$3
here=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/why-root.XXXXXX")
trap 'rm -rf "${work:?}"' EXIT
cp "$pkgs/record" "$work/record"
while read -r n _; do
  case $n in ''|*[!a-zA-Z0-9._+-]*) echo 'root: invalid package name' >&2; exit 1 ;; esac
  [ "$n" != why ] || { echo 'root: why is supplied by product composition' >&2; exit 1; }
  ln -s "$pkgs/$n" "$work/$n"
done < "$pkgs/record"
(cd "$here" && cargo build -q --locked --profile prompt -p why --no-default-features --target x86_64-unknown-linux-musl)
why="$here/target/x86_64-unknown-linux-musl/prompt/why"
mkdir -p "$work/why/tree/usr/bin" "$work/why/tree/etc/profile.d"
install -m 0644 "$here/why/make/shell.sh" "$work/why/tree/etc/profile.d/why.sh"
install -m 0755 "$why" "$work/why/tree/usr/bin/why"
printf '%s\n' 'NAME="OS Length3 Linux"' 'ID=length3' "VERSION=\"$version\"" "VERSION_ID=$version" "PRETTY_NAME=\"OS Length3 Linux $version\"" 'HOME_URL="https://github.com/elysia090/os-length3"' > "$work/why/tree/etc/os-release"
sha=$(sha256sum "$why" | cut -d' ' -f1)
source=$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)
if git -C "$here" status --porcelain -- why ':!why/app' ':!why/desktop' ':!why/test' ':!why/shipto/remote' 2>/dev/null | grep -q .; then source="$source+changed"; fi
printf '%s\n' "$version" > "$work/why/version"
printf '%s\n' "$source" > "$work/why/source"
printf '%s\n' "$sha" > "$work/why/key"
printf '%s\n' 'https://github.com/elysia090/os-length3' > "$work/why/url"
printf 'why %s %s\n' "$version" "$source" >> "$work/record"
printf 'why.sha256=%s\nwhy.source=%s\n' "$sha" "$source" > "$work/manifest"
sh "$here/module/ricebox/build/assemble.sh" "$work" "$out" "$version" os-length3-linux
