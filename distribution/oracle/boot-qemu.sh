#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 4 ]]; then
  echo "usage: $0 BZIMAGE INITRAMFS [SECONDS] [SYSTEM-SQUASHFS]" >&2
  exit 2
fi

here=$(cd -- "$(dirname -- "$0")" && pwd)
qemu=$($here/build-qemu.sh | tail -n 1)
kernel=$1
initramfs=$2
seconds=${3:-30}

# Keep the oracle inside the same deliberately narrow CPU contract used by
# native admission and the browser projection.  In particular, do not use
# `max`: it advertises optional instructions such as MONITOR/MWAIT that are not
# accepted by development-standard-v1 and can make Linux select an idle path
# which the product machine correctly rejects.
cpu='qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-xsave,-avx,-aes,-pclmulqdq,-monitor'
memory=512M
append='console=ttyS0,115200n8 earlyprintk=serial nokaslr rdinit=/init panic=-1'
system_options=()
if [[ $# -eq 4 ]]; then
  system_image=$4
  if [[ ! -f $system_image ]]; then
    echo "system image does not exist: $system_image" >&2
    exit 2
  fi
  system_bytes=$(stat -c %s -- "$system_image")
  if [[ ! $system_bytes =~ ^[1-9][0-9]*$ ]] \
      || (( system_bytes > 0x10000000 )); then
    echo "system image extent is outside the oracle contract" >&2
    exit 2
  fi
  printf -v system_extent '0x%x' "$system_bytes"
  system_address=0x30000000
  memory=1024M
  # QEMU's generic loader writes the immutable image into guest RAM.  Reserve
  # that exact interval before the page allocator starts, then expose it with
  # Linux's built-in phram driver.  The dollar sign is Linux memmap syntax;
  # keeping it in a single-quoted fragment avoids a shell-dependent launch.
  append+=" memmap=${system_extent}"'$'"${system_address}"
  append+=" phram.phram=system,${system_address},${system_extent}"
  system_options=(
    -device "loader,file=${system_image},addr=${system_address},force-raw=on"
  )
fi

exec timeout --foreground "$seconds" "$qemu" \
  -machine pc,accel=tcg \
  -cpu "$cpu" \
  -m "$memory" \
  -smp 1 \
  -kernel "$kernel" \
  -initrd "$initramfs" \
  -append "$append" \
  "${system_options[@]}" \
  -nodefaults \
  -no-reboot \
  -display none \
  -serial stdio
