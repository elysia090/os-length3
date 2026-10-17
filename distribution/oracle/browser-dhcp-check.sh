#!/bin/sh
# Candidate execution in a normal browser guest, never an installed-file patch.
# The local pinned packet gateway supplies this isolated fixed NAT geometry.
set -eu
test "$#" = 2 || { echo 'usage: browser-dhcp-check.sh ELF SHA256' >&2; exit 2; }
elf=$1
expected=$2
printf '%s  %s\n' "$expected" "$elf" | sha256sum -c -
work=$(mktemp -d /run/workspace/browser-check/dhcp-check.XXXXXXXX)
printf 'browser-dhcp-work:%s\n' "$work"
# A saved ACK selects reboot rather than fresh discovery. Preserve this test
# volume's regular lease and restore it even on a fault or failed assertion.
lease=/var/lib/dhcpcd/eth0.lease
test ! -L "$lease"
restore_lease() {
    result=$?
    trap - EXIT
    if test -f "$work/bootstrap.lease"; then
        if test -e "$lease" || test -L "$lease"; then
            echo 'refusing to overwrite a concurrently created DHCP lease' >&2
            exit 1
        fi
        mv "$work/bootstrap.lease" "$lease" || exit 1
    fi
    exit "$result"
}
trap restore_lease EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if test -e "$lease"; then
    test -f "$lease"
    mv "$lease" "$work/bootstrap.lease"
fi
# This only raises the existing guest NIC. Linux and dhcpcd, not the browser,
# own DHCP sockets, privileges, address configuration and received lease data.
/bin/busybox ip link set eth0 up
set +e
"$elf" -T -4 -t 10 eth0 >"$work/lease.log" 2>&1
status=$?
set -e
cat "$work/lease.log"
printf 'browser-dhcp-exit:%s\n' "$status"
test "$status" = 0
for field in "interface='eth0'" "protocol='dhcp'" "reason='TEST'" \
    "new_dhcp_message_type='2'" "new_ip_address='10.0.2.15'" \
    "new_subnet_mask='255.255.255.0'"; do
    grep -Fqx "$field" "$work/lease.log"
done
printf 'browser-dhcp:PASS:OFFER-address-subnet\n'
# Test mode does not configure routes or DNS. TLS/HTTPS and the signed package
# publication are independent requirements, not inferred from this witness.
