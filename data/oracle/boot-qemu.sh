#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 BZIMAGE INITRAMFS [SECONDS]" >&2
  exit 2
fi

here=$(cd -- "$(dirname -- "$0")" && pwd)
qemu=$($here/build-qemu.sh | tail -n 1)
kernel=$1
initramfs=$2
seconds=${3:-30}

exec timeout --foreground "$seconds" "$qemu" \
  -machine pc,accel=tcg \
  -cpu max \
  -m 512M \
  -smp 1 \
  -kernel "$kernel" \
  -initrd "$initramfs" \
  -append 'console=ttyS0,115200n8 earlyprintk=serial nokaslr rdinit=/init panic=-1' \
  -nodefaults \
  -no-reboot \
  -display none \
  -serial stdio
