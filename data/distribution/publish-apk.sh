#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# != 2 ]]; then
  printf 'usage: %s OPTIMIZED-PACKAGE-SET OUTPUT\n' "$0" >&2
  exit 2
fi
manifest=$(realpath -e -- "$1")
output=$2
here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
repo=$(cd -- "$data/.." && pwd)
. "$data/sources.env"
. "$here/profile.env"

signing_key=${QM_APK_SIGNING_KEY:?QM_APK_SIGNING_KEY must name the external private key}
public_key=${QM_APK_PUBLIC_KEY:?QM_APK_PUBLIC_KEY must name the release public key}
signing_key=$(realpath -e -- "$signing_key")
public_key=$(realpath -e -- "$public_key")
if [[ ${QM_ALLOW_TEST_SIGNING_KEY:-0} != 1 && \
      ( $signing_key == "$repo" || $signing_key == "$repo"/* ) ]]; then
  printf 'private package signing key must stay outside the repository: %s\n' \
    "$signing_key" >&2
  exit 1
fi
if grep -q 'PRIVATE KEY' "$public_key"; then
  printf 'public package key contains private key material: %s\n' \
    "$public_key" >&2
  exit 1
fi
private_id=$(openssl pkey -in "$signing_key" -pubout -outform DER | \
  sha256sum | cut -d' ' -f1)
public_id=$(openssl pkey -pubin -in "$public_key" -outform DER | \
  sha256sum | cut -d' ' -f1)
if [[ $private_id != "$public_id" ]]; then
  printf 'package signing private/public keys do not match\n' >&2
  exit 1
fi

bash "$here/check-package-recipes.sh" "$manifest" >/dev/null

# The static apk binary must observe canonical uid/gid directly.  A mapped
# user namespace does so without LD_PRELOAD, payload copies, or source edits.
if [[ ${QM_PACKAGE_USERNS:-0} != 1 ]]; then
  exec unshare --user --map-root-user \
    env QM_PACKAGE_USERNS=1 \
      QM_APK_SIGNING_KEY="$signing_key" QM_APK_PUBLIC_KEY="$public_key" \
      QM_ALLOW_TEST_SIGNING_KEY="${QM_ALLOW_TEST_SIGNING_KEY:-0}" \
      bash "$0" "$manifest" "$output"
fi
if [[ $(id -u):$(id -g) != 0:0 ]]; then
  printf 'package publication user namespace is not root-mapped\n' >&2
  exit 1
fi
if [[ -e $output ]]; then
  printf 'package publication output already exists: %s\n' "$output" >&2
  exit 1
fi

declare -a recipe_order=()
declare -A version=() description=() url=() license=() origin=()
declare -A depends=() provides=() replaces=() effects=() roots=()
package_recipe() {
  local name=$1
  recipe_order+=("$name")
  version[$name]=$2
  description[$name]=$3
  url[$name]=$4
  license[$name]=$5
  origin[$name]=$6
  depends[$name]=$7
  provides[$name]=$8
  replaces[$name]=$9
  effects[$name]=${10}
}
. "$here/package-recipes.sh"
unset -f package_recipe

while IFS=$'\t' read -r name root extra; do
  [[ -z $extra ]] || exit 1
  roots[$name]=$root
done < <(tail -n +2 -- "$manifest")
apk=${roots[apk-tools]}/usr/bin/apk
if [[ ! -x $apk ]]; then
  printf 'optimized package set has no executable apk-tools provider\n' >&2
  exit 1
fi

parent=$(dirname -- "$output")
name=$(basename -- "$output")
partial=$parent/.$name.partial.$$
cleanup() { rm -rf -- "$partial"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$partial/repository" "$partial/root/etc/apk/keys" \
  "$partial/package-trust/etc/apk/keys"
key_name=$(basename -- "$public_key")
install -m 0644 "$public_key" \
  "$partial/package-trust/etc/apk/keys/$key_name"
# Bootstrap repository verification from the same public bytes that the
# package-trust package will own after the transaction.
install -m 0644 "$public_key" "$partial/root/etc/apk/keys/$key_name"
roots[package-trust]=$partial/package-trust

packages=()
world=()
for package in "${recipe_order[@]}"; do
  root=${roots[$package]}
  # Apk records file mtimes.  Normalize the final owner root once, in place,
  # before signatures; no payload copy or parallel timestamp sidecar exists.
  find "$root" -exec touch -h -d "@$DISTRIBUTION_SOURCE_DATE_EPOCH" -- {} +
  package_file=$partial/repository/$package-${version[$package]}.apk
  info=(
    --info "name:$package"
    --info "version:${version[$package]}"
    --info arch:x86_64
    --info "description:${description[$package]}"
    --info "license:${license[$package]}"
    --info "origin:${origin[$package]}"
    --info "url:${url[$package]}"
  )
  [[ -z ${depends[$package]} ]] || \
    info+=(--info "depends:${depends[$package]}")
  [[ -z ${provides[$package]} ]] || \
    info+=(--info "provides:${provides[$package]}")
  [[ -z ${replaces[$package]} ]] || \
    info+=(--info "replaces:${replaces[$package]}")
  if [[ ${effects[$package]} != none ]]; then
    printf 'standard profile unexpectedly contains package effects: %s\n' \
      "$package" >&2
    exit 1
  fi
  "$apk" --sign-key "$signing_key" mkpkg --xattrs=yes \
    --files "$root" "${info[@]}" --output "$package_file"
  packages+=("$package_file")
  world+=("$package=${version[$package]}")
done

index=$partial/repository/Packages.adb
"$apk" --root "$partial/root" --sign-key "$signing_key" mkndx \
  --description "$DISTRIBUTION_PROFILE_ID" \
  --output "$index" "${packages[@]}"
"$apk" --root "$partial/root" verify "${packages[@]}" "$index"

mapfile -t sorted_world < <(printf '%s\n' "${world[@]}" | sort -u)
"$apk" --root "$partial/root" --logfile=no --no-network --no-scripts \
  --no-commit-hooks --repository "$index" add --initdb \
  "${sorted_world[@]}"
printf '%s\n' "$DISTRIBUTION_PACKAGE_REPOSITORY" \
  >"$partial/root/etc/apk/repositories"

bash "$here/check-package-state.sh" "$partial/root" >&2
mv -- "$partial" "$output"
trap - EXIT HUP INT TERM
printf '%s\n' "$output/root"
