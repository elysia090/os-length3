#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ $# != 5 ]]; then
  printf 'usage: %s APK-ROOT WORK SIGNING-KEY PUBLIC-KEY OUTPUT\n' "$0" >&2
  exit 2
fi
apk_root=$(realpath -e -- "$1")
work=$2
signing_key=$(realpath -e -- "$3")
public_key=$(realpath -e -- "$4")
output=$5
here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
. "$data/sources.env"
. "$here/profile.env"

if [[ -e $work || -e $output ]]; then
  printf 'apk publication check coordinate already exists\n' >&2
  exit 1
fi
mkdir -p "$work/roots"
declare -a names=()
package_recipe() { names+=("$1"); }
. "$here/package-recipes.sh"
unset -f package_recipe

specifications=()
for name in "${names[@]}"; do
  [[ $name != package-trust ]] || continue
  root=$work/roots/$name
  if [[ $name == apk-tools ]]; then
    mkdir -p "$root"
    cp -a "$apk_root/." "$root/"
  elif [[ $name == musl ]]; then
    # The production profile is statically linked. Keep this fixture faithful:
    # musl owns its archive under /usr, while /lib exists only because apk keeps
    # transaction state there.
    mkdir -p "$root/usr/lib"
    printf '%s\n' "$name" >"$root/usr/lib/libc.a"
  else
    mkdir -p "$root/usr/share/qm-package-smoke"
    printf '%s\n' "$name" >"$root/usr/share/qm-package-smoke/$name"
  fi
  specifications+=("$name:$root")
done

# Materialize the fixed profile's ownership coordinates in their declared
# synthetic owner. The real apk binary is retained, while other command files
# are minimal executables because this check targets package semantics rather
# than command behavior.
for specification in "${DISTRIBUTION_COMMAND_PROVIDERS[@]}"; do
  IFS='|' read -r _ path owner extra <<<"$specification"
  [[ -z $extra ]] || exit 1
  target=$work/roots/$owner$path
  if [[ ! -e $target && ! -L $target ]]; then
    install -D -m 0755 /dev/null "$target"
  fi
done
for specification in "${DISTRIBUTION_PATH_OWNERS[@]}"; do
  IFS='|' read -r path owner extra <<<"$specification"
  [[ -z $extra ]] || exit 1
  target=$work/roots/$owner$path
  if [[ ! -e $target && ! -L $target ]]; then
    install -D -m 0644 /dev/null "$target"
  fi
done
manifest=$(bash "$here/emit-package-set.sh" "$work" \
  publication-smoke v1 "${specifications[@]}")
QM_APK_SIGNING_KEY="$signing_key" QM_APK_PUBLIC_KEY="$public_key" \
  QM_ALLOW_TEST_SIGNING_KEY=1 \
  bash "$here/publish-apk.sh" "$manifest" "$output" >/dev/null

bash "$here/check-package-publication.sh" "$output" >/dev/null

expect_publication_rejection() {
  local description=$1
  if bash "$here/check-package-publication.sh" "$output" \
      >/dev/null 2>&1; then
    printf 'package publication accepted %s\n' "$description" >&2
    exit 1
  fi
}

# These are the four distinct authorities checked by publication: filesystem
# ownership, solver metadata, trigger state, and lifecycle scripts. Keep a real
# red for each so `--no-scripts` or apk's transaction-state audit cannot hide a
# policy regression.
mkdir -p "$output/root/opt"
printf 'unowned\n' >"$output/root/opt/unowned"
expect_publication_rejection 'an unowned persistent path'
rm -f -- "$output/root/opt/unowned"
rmdir -- "$output/root/opt"

installed=$output/root/lib/apk/db/installed
installed_backup=$work/installed.backup
cp -a -- "$installed" "$installed_backup"
awk '
  !changed && /^D:/ { print $0 " undeclared-dependency"; changed = 1; next }
  { print }
  END { if (!changed) exit 1 }
' "$installed_backup" >"$installed"
expect_publication_rejection 'dependency metadata outside the recipe'
cp -a -- "$installed_backup" "$installed"

triggers=$output/root/lib/apk/db/triggers
printf 'malicious\tusr/share\n' >"$triggers"
expect_publication_rejection 'undeclared trigger state'
: >"$triggers"

scripts=$output/root/lib/apk/db/scripts.tar.gz
scripts_backup=$work/scripts.tar.gz.backup
cp -a -- "$scripts" "$scripts_backup"
mkdir -p "$work/effect"
printf '#!/bin/sh\nexit 0\n' >"$work/effect/post-install"
tar -czf "$scripts" -C "$work/effect" post-install
expect_publication_rejection 'an undeclared package lifecycle script'
cp -a -- "$scripts_backup" "$scripts"

bash "$here/check-package-publication.sh" "$output" >/dev/null
printf 'complete apk publication transaction and policy negatives: green\n'
