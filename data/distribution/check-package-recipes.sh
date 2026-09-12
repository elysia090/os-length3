#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

manifest=${1:?usage: check-package-recipes.sh OPTIMIZED-PACKAGE-SET}
here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
. "$data/sources.env"
. "$here/profile.env"

if [[ $DISTRIBUTION_PACKAGE_POLICY_SCHEMA != apk-publication-v1 || \
      $DISTRIBUTION_PACKAGE_SELECTION_POLICY != exact-world-no-automatic-selection || \
      $DISTRIBUTION_PACKAGE_LAYER_POLICY != root-only || \
      $DISTRIBUTION_PACKAGE_EFFECT_POLICY != forbid || \
      $DISTRIBUTION_PACKAGE_LOG_POLICY != omit ]]; then
  printf 'unknown standard package policy\n' >&2
  exit 1
fi

declare -a recipe_order=()
declare -A version=() description=() url=() license=() origin=()
declare -A depends=() provides=() replaces=() effects=()

package_recipe() {
  if [[ $# != 10 ]]; then
    printf 'package recipe requires ten fields, got %s\n' "$#" >&2
    exit 2
  fi
  local name=$1 field
  if [[ ! $name =~ ^[a-z0-9][a-z0-9+_.-]*$ ]] || \
     [[ -n ${version[$name]+present} ]]; then
    printf 'invalid or duplicate package recipe: %s\n' "$name" >&2
    exit 1
  fi
  for field in "$2" "$3" "$4" "$5" "$6" "${10}"; do
    if [[ -z $field || $field == *$'\t'* || $field == *$'\n'* ]]; then
      printf 'invalid required metadata field for package: %s\n' "$name" >&2
      exit 1
    fi
  done
  if [[ ! $2 =~ ^[0-9][a-zA-Z0-9._+~-]*-r[0-9]+$ ]] || \
     [[ ! $4 =~ ^https:// ]] || \
     [[ ! $6 =~ ^[a-zA-Z0-9][a-zA-Z0-9+_.-]*$ ]] || \
     [[ -n $9 ]] || \
     [[ ${10} != none ]]; then
    printf 'noncanonical package metadata for: %s\n' "$name" >&2
    exit 1
  fi
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

if [[ ! -f $manifest ]] || \
   [[ $(head -n 1 -- "$manifest") != package-root-set-v1 ]]; then
  printf 'unknown or absent package-set: %s\n' "$manifest" >&2
  exit 2
fi

declare -A selected=() roots=()
selected[package-trust]=1
rows=$(mktemp)
cleanup() { rm -f -- "$rows"; }
trap cleanup EXIT HUP INT TERM
tail -n +2 -- "$manifest" >"$rows"
if [[ ! -s $rows ]] || ! sort -t $'\t' -k1,1 -c -u "$rows"; then
  printf 'package-set rows must be nonempty, sorted and unique\n' >&2
  exit 1
fi
while IFS=$'\t' read -r name root extra; do
  if [[ -n $extra || ! -d $root || -n ${selected[$name]+present} ]]; then
    printf 'invalid package-set row: %s %s\n' "$name" "$root" >&2
    exit 1
  fi
  selected[$name]=1
  roots[$name]=$root
  if [[ -z $(find "$root" -mindepth 1 ! -type d -print -quit) ]]; then
    printf 'package has no owned non-directory payload: %s\n' "$name" >&2
    exit 1
  fi
done <"$rows"

for name in "${recipe_order[@]}"; do
  if [[ -z ${selected[$name]+present} ]]; then
    printf 'package recipe is absent from the standard profile: %s\n' \
      "$name" >&2
    exit 1
  fi
done
for name in "${!selected[@]}"; do
  if [[ -z ${version[$name]+present} ]]; then
    printf 'standard package has no complete recipe: %s\n' "$name" >&2
    exit 1
  fi
done
if [[ ${#selected[@]} != ${#recipe_order[@]} ]]; then
  printf 'package recipe/profile cardinality differs: %s != %s\n' \
    "${#recipe_order[@]}" "${#selected[@]}" >&2
  exit 1
fi

# Validate the complete dependency graph once.  This is O(packages + edges),
# not one solver/path query per installed file.
declare -A indegree=() children=() provision_owner=()
for name in "${recipe_order[@]}"; do
  indegree[$name]=0
done
for name in "${recipe_order[@]}"; do
  declare -A seen_dependency=()
  for dependency in ${depends[$name]}; do
    if [[ ! $dependency =~ ^[a-z0-9][a-z0-9+_.-]*$ ]] || \
       [[ -z ${selected[$dependency]+present} ]] || \
       [[ $dependency == "$name" ]] || \
       [[ -n ${seen_dependency[$dependency]+present} ]]; then
      printf 'invalid dependency edge: %s -> %s\n' \
        "$name" "$dependency" >&2
      exit 1
    fi
    seen_dependency[$dependency]=1
    children[$dependency]="${children[$dependency]-} $name"
    indegree[$name]=$((indegree[$name] + 1))
  done
  for provision in ${provides[$name]}; do
    if [[ ! $provision =~ ^[a-zA-Z0-9][a-zA-Z0-9+_.:/-]*$ ]] || \
       [[ -n ${provision_owner[$provision]+present} ]]; then
      printf 'invalid provided name: %s -> %s\n' "$name" "$provision" >&2
      exit 1
    fi
    provision_owner[$provision]=$name
  done
  for replacement in ${replaces[$name]}; do
    if [[ ! $replacement =~ ^[a-z0-9][a-z0-9+_.-]*$ ]] || \
       [[ -z ${selected[$replacement]+present} ]] || \
       [[ $replacement == "$name" ]]; then
      printf 'invalid replacement relation: %s -> %s\n' \
        "$name" "$replacement" >&2
      exit 1
    fi
  done
  unset seen_dependency
done

queue=()
for name in "${recipe_order[@]}"; do
  if (( indegree[$name] == 0 )); then
    queue+=("$name")
  fi
done
visited=0
head=0
while (( head < ${#queue[@]} )); do
  name=${queue[$head]}
  head=$((head + 1))
  visited=$((visited + 1))
  for child in ${children[$name]-}; do
    indegree[$child]=$((indegree[$child] - 1))
    if (( indegree[$child] == 0 )); then
      queue+=("$child")
    fi
  done
done
if (( visited != ${#recipe_order[@]} )); then
  printf 'package dependency graph contains a cycle\n' >&2
  exit 1
fi

printf 'package recipes: green (%s packages)\n' "${#recipe_order[@]}"
