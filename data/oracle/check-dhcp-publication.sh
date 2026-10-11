#!/bin/sh
# Independent CPU gate for the pinned daemon, not a product execution path.
# A version/help check does not reach privilege-separated packet dispatch.
set -eu
. data/sources.env
repo=$PWD
scratch=$(mktemp -d /tmp/dhcp-publication.XXXXXXXX)
archive=data/upstream/dhcpcd-$DHCPCD_VERSION.tar.xz
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
cp data/config/passwd /etc/passwd
cp data/config/group /etc/group
mkdir -p /var/lib/dhcpcd
cp "$scratch/root/etc/dhcpcd.conf" /etc/dhcpcd.conf
# Keep the official TEST hook: exit zero without the returned lease fields
# is insufficient. These files belong only to this disposable oracle disk.
mkdir -p /usr/libexec
cp -a "$scratch/root/usr/libexec/." /usr/libexec/
src/v2/postlink-compiler/build/postlink-compiler \
    "$scratch/root/usr/bin/dhcpcd" -o "$scratch/dhcpcd-optimized"
failed=0
for role in dhcpcd-input dhcpcd-optimized; do
    case "$role" in dhcpcd-input) file=$scratch/root/usr/bin/dhcpcd;; *) file=$scratch/dhcpcd-optimized;; esac
    printf 'oracle-elf-begin %s %s\n' "$role" "$(sha256sum "$file" | cut -d ' ' -f 1)"
    zstd -q -c "$file" | base64
    printf 'oracle-elf-end\n'
    # Test mode requests a real DHCP lease without applying addresses or
    # spawning a persistent daemon. The oracle NIC has only restricted NAT.
    set +e
    "$file" -T -4 -t 3 eth0 >"$scratch/$role.log" 2>&1
    status=$?
    set -e
    cat "$scratch/$role.log"
    printf 'dhcp-publication:status:%s:%s\n' "$role" "$status"
    if test "$status" != 0 || ! grep -q '^new_ip_address=' "$scratch/$role.log"; then failed=1; fi
done
test "$failed" = 0
printf 'dhcp-publication:PASS:original-and-optimized-packet-dispatch\n'
