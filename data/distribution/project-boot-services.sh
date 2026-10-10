#!/usr/bin/env bash
set -euo pipefail
source_root=$1
full_database=$2
target=$3
database_tool=$4
compiler=$5
test ! -e "$target"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
"$database_tool" -c "$full_database" all-dependencies boot-offline >"$scratch/closure"
LC_ALL=C sort -u "$scratch/closure" >"$scratch/expected"
mkdir "$scratch/source"
while IFS= read -r name; do
    case $name in s6rc-*)continue;; esac
    if [[ ! $name =~ ^[a-zA-Z0-9_-]+$ || ! -d $source_root/$name ]];then
        printf 'invalid boot closure service: %s\n' "$name" >&2;exit 1
    fi
    directory=$scratch/source/$name
    mkdir "$directory"
    # Derive canonical dependencies from the one compiled graph. No second
    # hand-maintained boot/network service list becomes an authority.
    for input in "$source_root/$name"/*;do
        case ${input##*/} in dependencies|dependencies.d)continue;;esac
        [[ -e $input ]] && cp -a -- "$input" "$directory/"
    done
    "$database_tool" -c "$full_database" dependencies "$name" >"$scratch/direct"
    mkdir "$directory/dependencies.d"
    while IFS= read -r dependency;do
        case $dependency in s6rc-*)continue;;esac
        grep -qxF "$dependency" "$scratch/expected"
        : >"$directory/dependencies.d/$dependency"
    done <"$scratch/direct"
done <"$scratch/expected"
mkdir -p "$scratch/source/boot-offline/contents.d"
printf 'bundle\n' >"$scratch/source/boot-offline/type"
while IFS= read -r name;do
    case $name in s6rc-*)continue;;esac
    : >"$scratch/source/boot-offline/contents.d/$name"
done <"$scratch/expected"
"$compiler" "$target" "$scratch/source"
"$database_tool" -c "$target" check
"$database_tool" -c "$target" all-dependencies boot-offline >"$scratch/actual"
LC_ALL=C sort -u "$scratch/actual" >"$scratch/actual.sorted"
cmp "$scratch/expected" "$scratch/actual.sorted"
printf 'boot service projection: exact dependency closure, no network/time supervisors\n'
