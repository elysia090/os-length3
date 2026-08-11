#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: $0 /path/to/static-busybox /path/to/initramfs.cpio.gz" >&2
    exit 2
fi

busybox=$1
output=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT HUP INT TERM

mkdir -p "$work/bin" "$work/dev" "$work/proc" "$work/sys"
cp "$busybox" "$work/bin/busybox"
chmod 0755 "$work/bin/busybox"
for command in sh mount echo setsid cttyhack; do
    ln -s busybox "$work/bin/$command"
done
cp "$script_dir/x86-init" "$work/init"
chmod 0755 "$work/init"

mkdir -p "$(dirname -- "$output")"
(
    cd "$work"
    find . -print0 | sort -z | cpio --null -o --format=newc --owner=0:0
) | gzip -9n > "$output"
