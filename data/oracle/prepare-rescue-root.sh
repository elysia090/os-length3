#!/bin/sh
# Diagnostic artifact only. Failure remains failure; this is not readiness.
set -eu
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
head -c 89874432 /dev/vdd >"$scratch/input.squashfs"
printf '%s  %s\n' f971b50b806cb226172d88afbd6b45258da1cf7a89b1472e067f58006d29d280 "$scratch/input.squashfs" | sha256sum -c -
unsquashfs -processors 1 -d "$scratch/root" "$scratch/input.squashfs" >/dev/null
file=$scratch/root/usr/libexec/system/boot
grep -q 'terminal remains down' "$file"
# Only the failure trap differs. Service graph, CPU profile,10s deadlines,
# clock and all executable payloads stay identical to the rebuilt candidate.
sed -i '/^trap .*terminal remains down/c\trap '\''echo "DIAGNOSTIC RESCUE: offline transition failed; NOT interactive-ready." >&2; /usr/bin/s6-svc -u /run/service/console'\'' EXIT' "$file"
sh -n "$file"
mksquashfs "$scratch/root" "$scratch/system.squashfs" -noappend -comp zstd -processors 1 -mkfs-time 0 -no-progress >/dev/null
mkdir "$scratch/output"
device=/dev/vde1;test -b "$device" || device=/dev/vde
mount -t vfat "$device" "$scratch/output"
cp "$scratch/system.squashfs" "$scratch/output/system.squashfs"
printf 'oracle-candidate system.squashfs %s %s\n' "$(wc -c <"$scratch/system.squashfs" | tr -d ' ')" "$(sha256sum "$scratch/system.squashfs" | cut -d ' ' -f 1)"
sync;umount "$scratch/output"
