#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

publication=${1:?usage: check-package-publication.sh PUBLICATION}
if [[ ! -d $publication/root || ! -d $publication/repository ]]; then
  printf 'signed package publication is incomplete: %s\n' \
    "$publication" >&2
  exit 2
fi
publication=$(cd -- "$publication" && pwd)

# apk's full ownership audit deliberately rejects its unprivileged usermode.
# Observe the payload's canonical 0:0 ownership through the same one-to-one
# user namespace used by publication; do not add a fakeroot database or copy.
if [[ ${QM_PACKAGE_USERNS:-0} != 1 ]]; then
  exec unshare --user --map-root-user \
    env QM_PACKAGE_USERNS=1 bash "$0" "$publication"
fi
if [[ $(id -u):$(id -g) != 0:0 ]]; then
  printf 'package publication check is not root-mapped\n' >&2
  exit 1
fi

root=$publication/root
repository=$publication/repository
here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
. "$data/sources.env"
. "$here/profile.env"

apk=$root/usr/bin/apk
index=$repository/Packages.adb
if [[ ! -x $apk || ! -s $index ]]; then
  printf 'publication lacks apk or its signed index: %s\n' \
    "$publication" >&2
  exit 1
fi

expected_packages=$(mktemp)
actual_packages=$(mktemp)
expected_installed=$(mktemp)
actual_installed=$(mktemp)
actual_world=$(mktemp)
effect_metadata=$(mktemp)
script_entries=$(mktemp)
cleanup() {
  rm -f -- "$expected_packages" "$actual_packages" \
    "$expected_installed" "$actual_installed" "$actual_world" \
    "$effect_metadata" "$script_entries"
}
trap cleanup EXIT HUP INT TERM

declare -a recipe_order=()
declare -A expected_version=() expected_description=() expected_url=()
declare -A expected_license=() expected_origin=() expected_depends=()
declare -A expected_provides=() expected_replaces=() expected_effects=()
package_recipe() {
  local name=$1 version=$2
  recipe_order+=("$name")
  expected_version[$name]=$version
  expected_description[$name]=$3
  expected_url[$name]=$4
  expected_license[$name]=$5
  expected_origin[$name]=$6
  expected_depends[$name]=$7
  expected_provides[$name]=$8
  expected_replaces[$name]=$9
  expected_effects[$name]=${10}
  printf '%s-%s.apk\n' "$name" "$version" >>"$expected_packages"
  printf '%s=%s\n' "$name" "$version" >>"$expected_installed"
}
. "$here/package-recipes.sh"
unset -f package_recipe
sort -u -o "$expected_packages" "$expected_packages"
sort -u -o "$expected_installed" "$expected_installed"

find "$repository" -maxdepth 1 -type f -name '*.apk' -printf '%f\n' | \
  sort -u >"$actual_packages"
if ! cmp -s "$expected_packages" "$actual_packages"; then
  printf 'signed repository package closure differs from the fixed recipe\n' \
    >&2
  diff -u "$expected_packages" "$actual_packages" >&2 || true
  exit 1
fi

awk '
  /^P:/ { package = substr($0, 3); next }
  /^V:/ && package != "" {
    print package "=" substr($0, 3)
    package = ""
  }
' "$root/lib/apk/db/installed" | sort -u >"$actual_installed"
if ! cmp -s "$expected_installed" "$actual_installed"; then
  printf 'installed package closure differs from the fixed recipe\n' >&2
  diff -u "$expected_installed" "$actual_installed" >&2 || true
  exit 1
fi
sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' \
  "$root/etc/apk/world" | sort -u >"$actual_world"
if ! cmp -s "$expected_installed" "$actual_world"; then
  printf 'installed world differs from the fixed exact recipe\n' >&2
  diff -u "$expected_installed" "$actual_world" >&2 || true
  exit 1
fi

# Decode apk's installed metadata and path stream once. `P` selects the
# package, `F` the current directory and `R` a non-directory record in that
# directory. This makes both metadata equality and provider ownership a linear
# installed-population check rather than one apk query per package or path.
declare -A path_owner=()
declare -A actual_version=() actual_arch=() actual_description=()
declare -A actual_url=() actual_license=() actual_origin=()
declare -A actual_depends=() actual_provides=() actual_replaces=()
declare -A metadata_seen=()
current_package=
current_directory=
while IFS= read -r record; do
  case $record in
    P:*)
      current_package=${record#P:}
      current_directory=
      if [[ -n ${metadata_seen[$current_package]+present} ]]; then
        printf 'duplicate installed package metadata: %s\n' \
          "$current_package" >&2
        exit 1
      fi
      metadata_seen[$current_package]=1
      ;;
    V:*) actual_version[$current_package]=${record#V:} ;;
    A:*) actual_arch[$current_package]=${record#A:} ;;
    T:*) actual_description[$current_package]=${record#T:} ;;
    U:*) actual_url[$current_package]=${record#U:} ;;
    L:*) actual_license[$current_package]=${record#L:} ;;
    o:*) actual_origin[$current_package]=${record#o:} ;;
    D:*) actual_depends[$current_package]=${record#D:} ;;
    p:*) actual_provides[$current_package]=${record#p:} ;;
    r:*) actual_replaces[$current_package]=${record#r:} ;;
    F:*) current_directory=${record#F:} ;;
    R:*)
      if [[ -n $current_directory ]]; then
        owned_path=/$current_directory/${record#R:}
      else
        owned_path=/${record#R:}
      fi
      if [[ -z $current_package || -n ${path_owner[$owned_path]+present} ]]; then
        printf 'invalid or duplicate installed path ownership: %s\n' \
          "$owned_path" >&2
        exit 1
      fi
      path_owner[$owned_path]=$current_package
      ;;
  esac
done <"$root/lib/apk/db/installed"

canonical_words() {
  local words=$1
  if [[ -n $words ]]; then
    tr ' ' '\n' <<<"$words" | sed '/^$/d' | sort -u | paste -sd ' ' -
  fi
}

require_metadata() {
  local package=$1 field=$2 expected=$3 actual=$4
  if [[ $actual != "$expected" ]]; then
    printf 'installed package metadata differs: %s %s (%s != %s)\n' \
      "$package" "$field" "$actual" "$expected" >&2
    exit 1
  fi
}

for package in "${recipe_order[@]}"; do
  require_metadata "$package" version "${expected_version[$package]}" \
    "${actual_version[$package]-}"
  require_metadata "$package" arch x86_64 "${actual_arch[$package]-}"
  require_metadata "$package" description "${expected_description[$package]}" \
    "${actual_description[$package]-}"
  require_metadata "$package" url "${expected_url[$package]}" \
    "${actual_url[$package]-}"
  require_metadata "$package" license "${expected_license[$package]}" \
    "${actual_license[$package]-}"
  require_metadata "$package" origin "${expected_origin[$package]}" \
    "${actual_origin[$package]-}"
  require_metadata "$package" depends \
    "$(canonical_words "${expected_depends[$package]}")" \
    "$(canonical_words "${actual_depends[$package]-}")"
  require_metadata "$package" provides \
    "$(canonical_words "${expected_provides[$package]}")" \
    "$(canonical_words "${actual_provides[$package]-}")"
  require_metadata "$package" replaces \
    "$(canonical_words "${expected_replaces[$package]}")" \
    "$(canonical_words "${actual_replaces[$package]-}")"
  require_metadata "$package" effects none "${expected_effects[$package]}"
done

# The standard profile has no lifecycle effects and no solver metadata that
# silently changes selection. Query the installed database in one pass and
# reject every field other than the package name. `--no-scripts` is therefore
# only defense in depth during assembly; it cannot turn an effectful package
# into an admitted package by skipping its declared semantics.
"$apk" --root "$root" query --from installed --format yaml \
  --fields name,maintainer,commit,build-time,provider-priority,install-if,layer,tags,triggers,scripts,replaces-priority \
  '*' >"$effect_metadata"
if grep -Ev '^# [0-9]+ items$|^- name: [a-zA-Z0-9][a-zA-Z0-9+_.-]*$|^[[:space:]]*$' \
    "$effect_metadata" >/dev/null; then
  printf 'standard package contains forbidden solver/effect metadata:\n' >&2
  sed -n '1,80p' "$effect_metadata" >&2
  exit 1
fi

scripts_archive=$root/lib/apk/db/scripts.tar.gz
if [[ -e $scripts_archive ]]; then
  if ! tar -tzf "$scripts_archive" >"$script_entries" 2>/dev/null; then
    printf 'installed apk script archive is invalid\n' >&2
    exit 1
  fi
  if [[ -s $script_entries ]]; then
    printf 'standard package set contains lifecycle scripts\n' >&2
    sed -n '1,40p' "$script_entries" >&2
    exit 1
  fi
fi
if [[ -s $root/lib/apk/db/triggers ]]; then
  printf 'standard package set contains directory triggers\n' >&2
  exit 1
fi
for hook_directory in "$root/etc/apk/commit_hooks.d" \
    "$root/lib/apk/commit_hooks.d"; do
  if [[ -d $hook_directory ]] && \
     [[ -n $(find "$hook_directory" -mindepth 1 -print -quit) ]]; then
    printf 'standard package set contains apk commit hooks: /%s\n' \
      "${hook_directory#"$root"/}" >&2
    exit 1
  fi
done

check_owner() {
  local path expected actual
  path=$1
  expected=$2
  actual=${path_owner[$path]-}
  if [[ $actual != "$expected" ]]; then
    printf 'installed path owner differs: %s (%s != %s)\n' \
      "$path" "${actual:-unowned}" "$expected" >&2
    exit 1
  fi
}
for specification in "${DISTRIBUTION_COMMAND_PROVIDERS[@]}"; do
  IFS='|' read -r _ path owner extra <<<"$specification"
  [[ -z $extra ]] || exit 1
  check_owner "$path" "$owner"
done
for specification in "${DISTRIBUTION_PATH_OWNERS[@]}"; do
  IFS='|' read -r path owner extra <<<"$specification"
  [[ -z $extra ]] || exit 1
  check_owner "$path" "$owner"
done
while IFS= read -r trust_path; do
  check_owner "/${trust_path#"$root"/}" package-trust
done < <(find "$root/etc/apk/keys" -type f -print)

# Every retained non-directory has exactly one authority. Apk transaction
# state is the only non-package class; logs, caches, locks and extraction
# scratch are deliberately absent from the immutable release.
declare -A transaction_path=()
for path in "${DISTRIBUTION_APK_TRANSACTION_PATHS[@]}"; do
  if [[ $path != /* || -n ${transaction_path[$path]+present} ]]; then
    printf 'invalid apk transaction path policy: %s\n' "$path" >&2
    exit 1
  fi
  transaction_path[$path]=1
done
for path in "${!transaction_path[@]}"; do
  if [[ -n ${path_owner[$path]+present} ]]; then
    printf 'apk transaction path is incorrectly package-owned: %s\n' \
      "$path" >&2
    exit 1
  fi
  if [[ ! -e $root$path && ! -L $root$path ]]; then
    printf 'required apk transaction path is absent: %s\n' "$path" >&2
    exit 1
  fi
done
while IFS= read -r -d '' path; do
  path=/${path#./}
  if [[ -z ${path_owner[$path]+present} && \
        -z ${transaction_path[$path]+present} ]]; then
    printf 'persistent path has no package or transaction authority: %s\n' \
      "$path" >&2
    exit 1
  fi
done < <(cd -- "$root" && find . -mindepth 1 ! -type d -print0)

mapfile -t packages < <(find "$repository" -maxdepth 1 -type f \
  -name '*.apk' -print | sort)
"$apk" --root "$root" verify "${packages[@]}" "$index" >/dev/null

repository_coordinate=$(sed -e '/^[[:space:]]*#/d' \
  -e '/^[[:space:]]*$/d' "$root/etc/apk/repositories")
if [[ $repository_coordinate != "$DISTRIBUTION_PACKAGE_REPOSITORY" ]]; then
  printf 'installed repository coordinate is not canonical: %s\n' \
    "$repository_coordinate" >&2
  exit 1
fi

bash "$here/check-package-state.sh" "$root" >/dev/null
printf 'signed apk repository, package closure, and ownership: green\n'
