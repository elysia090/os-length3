#!/bin/sh
set -eu
# The exact historical BusyBox was already authenticated and expanded. Produce
# current exact system-config bytes with the unchanged recipe; record a key
# for this private build input scheme, never a fabricated stock cache key.
[ "$#" -eq 3 ]
checkout=$(cd "$1" && pwd)
pack=$(cd "$2" && pwd)
work=$(cd "$3" && pwd)
export HOME="$work/home" LC_ALL=C LANG=C SOURCE_DATE_EPOCH=0
umask 022
mkdir -p "$HOME" "$work/check-config" "$work/check-busybox"
test "$(git hash-object "$checkout/ricebox/distribution/packages/busybox/recipe.sh")" = 8332c7c037049327048cd7b13db1e8c4b557bc53
test "$(git hash-object "$checkout/ricebox/distribution/packages/system-config/recipe.sh")" = d82fd03818e3c27f76891a2fce2aaa3da16f8554
test "$(git hash-object "$checkout/ricebox/distribution/pins/sources.env")" = d205c599520ec1a8bac140d71c9331754d94bdd7
here="$checkout/ricebox/distribution"
recipes="$here/packages"
. "$here/pins/sources.env"
test "$(cat "$pack/busybox/version")" = "$BUSYBOX_VERSION"
test "$(cat "$pack/busybox/source")" = "$BUSYBOX_SHA256"
printf '%s  %s\n' 5b10f1705ad5250b74aa56548d72263db52c9737061db005c8186c8c295e4d63 "$pack/busybox/tree/usr/bin/busybox" | sha256sum -c -
(
  cd "$work/check-busybox"
  dest="$pack/busybox/tree"
  not() { ! "$@"; }
  . "$recipes/busybox/recipe.sh"
  check
)
mkdir -p "$pack/system-config/tree"
(
  cd "$work/check-config"
  dest="$pack/system-config/tree"
  . "$recipes/system-config/recipe.sh"
  build
  check
  test "$version" = 1
  for f in $inputs; do cmp "$here/$f" "$dest/$f"; done
  count=$(printf '%s\n' $inputs | wc -l)
  test "$count" -eq 11
  test "$(find "$dest" -type f | wc -l)" -eq "$count"
  echo "$version" > "$pack/system-config/version"
  : > "$pack/system-config/source"
  {
    printf '%s\n' 'private-current-config-byte-v1'
    sha256sum "$recipes/system-config/recipe.sh" | cut -d' ' -f1
    for f in $inputs; do
      printf '%s %s %s\n' "$f" "$(stat -c %a "$dest/$f")" "$(sha256sum "$dest/$f" | cut -d' ' -f1)"
    done
  } > "$work/private-config-receipt.txt"
  sha256sum "$work/private-config-receipt.txt" | cut -d' ' -f1 > "$pack/system-config/key"
)
printf 'busybox %s %s\nsystem-config 1\n' "$BUSYBOX_VERSION" "$BUSYBOX_SHA256" > "$pack/record"
cat > "$pack/manifest" <<'MANIFEST'
base.profile=published-busybox-current-config-v1
private.probe_only=true
private.base_revision=28c45a65649b1058da0ad5077624e8fd4fa3cee9
private.published_busybox_carrier=ec84d6a4f34359f322726e323e294b03987a19b1aa544563c846ca1a83060ee3
private.busybox_key_scope=historical_official_publisher
private.system_config_key_scope=current_recipe_bytes_private_not_stock_cache
MANIFEST
echo 'Exact BusyBox recipe check and current system-config build/check passed; stock package build not attempted.'
