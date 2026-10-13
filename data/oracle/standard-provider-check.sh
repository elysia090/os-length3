#!/bin/sh
# Execute in the normally booted candidate. No host routes or files are used.
set -eu
export PATH=/usr/bin:/usr/sbin:/bin:/sbin
work=$(mktemp -d /tmp/provider-check.XXXXXXXX)
for name in ip mount umount lsmod modprobe rmmod su passwd tar; do
    actual=$(command -v "$name")
    test "$actual" = "/usr/bin/$name" || {
        printf 'provider-check:FAIL:%s:%s\n' "$name" "$actual" >&2
        exit 1
    }
done
/bin/sh -c 'test "$(command -v ip)" = /usr/bin/ip; ip -Version' > "$work/shell.txt"
grep -q 'iproute2-' "$work/shell.txt"
printf '' | /bin/busybox xargs ip -Version > "$work/xargs.txt"
grep -q 'iproute2-' "$work/xargs.txt"
ip link set lo up
ip addr replace 192.0.2.9/24 dev lo
ip route replace default via 192.0.2.1 dev lo
ip route > "$work/route.txt"
grep -q '^default via 192.0.2.1 dev lo' "$work/route.txt"
cat "$work/shell.txt" "$work/xargs.txt" "$work/route.txt"
printf 'provider-check:PASS:normal-shell-xargs-and-route\n'
