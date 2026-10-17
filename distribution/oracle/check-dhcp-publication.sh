#!/bin/sh
# Independent CPU gate for the pinned daemon, not a product execution path.
# A version/help check does not reach privilege-separated packet dispatch.
set -eu
. distribution/sources.env
repo=$PWD
scratch=$(mktemp -d /tmp/dhcp-publication.XXXXXXXX)
archive=distribution/upstream/dhcpcd-$DHCPCD_VERSION.tar.xz
printf '%s  %s\n' "$DHCPCD_SHA256" "$archive" | sha256sum -c -
tar -xJf "$archive" -C "$scratch"
cd "$scratch/dhcpcd-$DHCPCD_VERSION"
CFLAGS='-O2 -Wno-error=parentheses' LDFLAGS='-static -Wl,--emit-relocs' \
    ./configure --prefix=/usr --bindir=/usr/bin --sbindir=/usr/bin \
    --libexecdir=/usr/libexec --sysconfdir=/etc --dbdir=/var/lib/dhcpcd \
    --rundir=/run --privsepuser=dhcpcd --without-udev --without-openssl
make -j4
make DESTDIR="$scratch/root" install
cd "$repo"
cp distribution/config/passwd /etc/passwd
cp distribution/config/group /etc/group
mkdir -p /var/lib/dhcpcd
cp "$scratch/root/etc/dhcpcd.conf" /etc/dhcpcd.conf
# Keep the official TEST hook: exit zero without the returned lease fields
# is insufficient. These files belong only to this disposable oracle disk.
mkdir -p /usr/libexec
cp -a "$scratch/root/usr/libexec/." /usr/libexec/
compiler/postlink-compiler/build/postlink-compiler \
    "$scratch/root/usr/bin/dhcpcd" -o "$scratch/dhcpcd-optimized"
failed=0
for role in dhcpcd-input dhcpcd-optimized; do
    case "$role" in dhcpcd-input) file=$scratch/root/usr/bin/dhcpcd;; *) file=$scratch/dhcpcd-optimized;; esac
    printf 'oracle-elf-begin %s %s\n' "$role" "$(sha256sum "$file" | cut -d ' ' -f 1)"
    zstd -q -c "$file" | base64
    printf 'oracle-elf-end\n'
    # The bootstrap NIC may already have a saved ACK. Preserve that oracle
    # file outside dhcpcd's coordinate so each role exercises fresh discovery.
    # Official TEST mode stops at OFFER; it is not an ACK/address install gate.
    lease=/var/lib/dhcpcd/eth0.lease
    test ! -L "$lease"
    if test -e "$lease"; then
        test -f "$lease"
        mv "$lease" "$scratch/$role.bootstrap.lease"
    fi
    # Test mode requests a real DHCP lease without applying addresses or
    # spawning a persistent daemon. The oracle NIC has only restricted NAT.
    set +e
    "$file" -T -4 -t 3 eth0 >"$scratch/$role.log" 2>&1
    status=$?
    set -e
    cat "$scratch/$role.log"
    printf 'dhcp-publication:status:%s:%s\n' "$role" "$status"
    # The isolated oracle owns this fixed NAT lease. Require the OFFER and its
    # complete address geometry; a zero exit or a cached address is not a
    # privilege-separated DHCP packet-dispatch witness by itself.
    if test "$status" != 0; then failed=1; fi
    for field in "interface='eth0'" "protocol='dhcp'" "reason='TEST'" \
        "new_dhcp_message_type='2'" "new_ip_address='10.0.2.15'" \
        "new_subnet_mask='255.255.255.0'"; do
        if ! grep -Fqx "$field" "$scratch/$role.log"; then failed=1; fi
    done
done
test "$failed" = 0
printf 'dhcp-publication:PASS:original-and-optimized-fresh-offer\n'
