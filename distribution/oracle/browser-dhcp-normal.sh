#!/bin/sh
# Real normal-daemon ACK/configuration gate on the pinned local packet gateway.
# No host address, route or resolver injection; candidate bytes are independent
# test inputs, not a mutation of an installed signed package.
set -eu
test "$#" = 2 || { echo 'usage: browser-dhcp-normal.sh ELF SHA256' >&2; exit 2; }
elf=$1
printf '%s  %s\n' "$2" "$elf" | sha256sum -c -
work=$(mktemp -d /run/workspace/browser-check/dhcp-normal.XXXXXXXX)
printf 'browser-dhcp-normal-work:%s\n' "$work"
/bin/busybox ip link set eth0 up
set +e
"$elf" -B -4 -1 -t 10 eth0 >"$work/daemon.log" 2>&1
status=$?
set -e
cat "$work/daemon.log"
printf 'browser-dhcp-normal-exit:%s\n' "$status"
test "$status" = 0
grep -Eq '^eth0: leased 10\.0\.2\.15 for [0-9]+ seconds$' "$work/daemon.log"
# Dump the daemon's actual saved ACK, not a browser-created address manifest.
test -f /var/lib/dhcpcd/eth0.lease
test ! -L /var/lib/dhcpcd/eth0.lease
"$elf" -U -4 - </var/lib/dhcpcd/eth0.lease >"$work/ack.log" 2>&1
cat "$work/ack.log"
# The official stdin dump spells unprefixed, unquoted key=value rows, unlike
# the TEST hook's shell environment. Check that interface rather than inventing
# hook metadata for a daemon which has already exited.
for field in 'dhcp_message_type=5' 'ip_address=10.0.2.15' \
    'subnet_mask=255.255.255.0' 'routers=10.0.2.2' \
    'domain_name_servers=10.0.2.3'; do
    grep -Fqx "$field" "$work/ack.log"
done
/bin/busybox ip addr show eth0 >"$work/address.log"
/bin/busybox ip route >"$work/route.log"
cat "$work/address.log" "$work/route.log" /etc/resolv.conf
grep -Eq '^[[:space:]]+inet 10\.0\.2\.15/24 ' "$work/address.log"
grep -Eq '^default via 10\.0\.2\.2 dev eth0( |$)' "$work/route.log"
grep -Fxq 'nameserver 10.0.2.3' /etc/resolv.conf
printf 'browser-dhcp-normal:PASS:ACK-address-default-route-DNS\n'
# This does not prove HTTPS or the release's service graph/publication.
