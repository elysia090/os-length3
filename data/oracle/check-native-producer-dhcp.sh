#!/bin/sh
# Actual clean Linux builds and ordinary DHCP; no signing key or observer.
set -eu
test -n "${BASH_VERSION:-}" || exec bash "$0" "$@"
trap 'printf "producer-dhcp:failed:line=%s\n" "$LINENO" >&2' ERR
export LC_ALL=C
repo=$PWD
. data/bootstrap/environment.sh
. data/sources.env
scratch=$(mktemp -d /build/producer-dhcp.XXXXXXXX)
printf 'producer-rebuild:host:%s\n' "$(uname -smr)"
printf 'producer-rebuild:cc:%s\n' "$(gcc --version | head -n 1)"
printf 'producer-rebuild:flags:CC=/usr/bin/gcc AR=/usr/bin/ar CFLAGS=-O2\n'
sha256sum /usr/bin/gcc /usr/bin/ld /usr/bin/ar /usr/bin/make
printf 'producer-rebuild:bootstrap:%s\n' "$QM_BOOTSTRAP_ID"

# Both trees start without objects/archives/build directories. They consume the
# same source cut and recorded installed bootstrap, not the harness's prebuild.
for role in first second; do
    mkdir -p "$scratch/$role"
    tar --exclude=build --exclude=.git -cf - src/v2 |
        tar -xf - -C "$scratch/$role"
    tree=$scratch/$role/src/v2
    (cd "$tree"; find . -type f -print0 | sort -z |
        xargs -0 sha256sum | sha256sum) >"$scratch/$role.source"
done
cmp "$scratch/first.source" "$scratch/second.source"
printf 'producer-rebuild:source:'
cat "$scratch/first.source"
for role in first second; do
    make -j2 -C "$scratch/$role/src/v2" \
        CC=/usr/bin/gcc AR=/usr/bin/ar CFLAGS=-O2 all >"$scratch/$role.build.log" 2>&1 || {
        tail -n 60 "$scratch/$role.build.log" >&2; exit 1;
    }
done
first=$scratch/first/src/v2
second=$scratch/second/src/v2
for file in postlink-compiler/build/postlink-compiler optimized-x86/build/postlink-verify \
    build/artifact-executable-stage artifact/build/artifact-measure-root; do
    cmp "$first/$file" "$second/$file"
    printf 'producer-rebuild:binary:%s:%s\n' "$file" "$(sha256sum "$first/$file" | cut -d ' ' -f1)"
done
printf 'producer-rebuild:PASS:two-clean-builds-same-source-toolchain-flags\n'

archive=$repo/data/upstream/dhcpcd-$DHCPCD_VERSION.tar.xz
printf '%s  %s\n' "$DHCPCD_SHA256" "$archive" | sha256sum -c -
tar -xJf "$archive" -C "$scratch"
cd "$scratch/dhcpcd-$DHCPCD_VERSION"
CFLAGS='-O2 -Wno-error=parentheses' LDFLAGS='-static -Wl,--emit-relocs' \
    ./configure --prefix=/usr --bindir=/usr/bin --sbindir=/usr/bin \
    --libexecdir=/usr/libexec --sysconfdir=/etc --dbdir=/var/lib/dhcpcd \
    --rundir=/run --privsepuser=dhcpcd --without-udev --without-openssl
make -j2
make DESTDIR="$scratch/dhcp-root" install
cd "$repo"
cp data/config/passwd /etc/passwd
cp data/config/group /etc/group
mkdir -p /var/lib/dhcpcd /usr/libexec
cp "$scratch/dhcp-root/etc/dhcpcd.conf" /etc/dhcpcd.conf
cp -a "$scratch/dhcp-root/usr/libexec/." /usr/libexec/
"$first/postlink-compiler/build/postlink-compiler" \
    "$scratch/dhcp-root/usr/bin/dhcpcd" -o "$scratch/dhcpcd-optimized"
"$first/optimized-x86/build/postlink-verify" \
    "$scratch/dhcp-root/usr/bin/dhcpcd" "$scratch/dhcpcd-optimized"

# Ordinary syslog and privilege separation remain enabled. Each role gets its
# own fresh lease; the disposable volume retains any bootstrap lease separately.
for role in dhcpcd-input dhcpcd-optimized; do
    case $role in dhcpcd-input) file=$scratch/dhcp-root/usr/bin/dhcpcd;;
        *) file=$scratch/dhcpcd-optimized;; esac
    printf 'oracle-elf-begin %s %s\n' "$role" "$(sha256sum "$file" | cut -d ' ' -f1)"
    zstd -q -c "$file" | base64
    printf 'oracle-elf-end\n'
done
for role in dhcpcd-input dhcpcd-optimized; do
    case $role in dhcpcd-input) file=$scratch/dhcp-root/usr/bin/dhcpcd;;
        *) file=$scratch/dhcpcd-optimized;; esac
    lease=/var/lib/dhcpcd/eth0.lease
    test ! -L "$lease"
    if test -e "$lease"; then
        test -f "$lease"
        mv "$lease" "$scratch/$role.prior.lease"
    fi
    set +e
    "$file" -B -4 -1 -t 10 eth0 >"$scratch/$role.normal.log" 2>&1
    status=$?
    set -e
    cat "$scratch/$role.normal.log"
    printf 'dhcp-normal:status:%s:%s\n' "$role" "$status"
    test "$status" = 0
    grep -Eq '^eth0: leased 10\.0\.2\.15 for [0-9]+ seconds$' "$scratch/$role.normal.log"
    if ! test -f "$lease"; then
        printf 'dhcp-normal:missing-lease:%s\n' "$lease" >&2
        find /var/lib/dhcpcd -name '*.lease*' -type f -print >&2
        exit 1
    fi
    "$file" -U -4 - <"$lease" >"$scratch/$role.ack"
    cat "$scratch/$role.ack"
    # QEMU restrict=on deliberately omits gateway/DNS DHCP options. This
    # independent native witness is ACK/address, not product network-ready.
    # The ordinary browser gateway gate separately requires route and DNS.
    for field in 'dhcp_message_type=5' 'ip_address=10.0.2.15' \
        'subnet_mask=255.255.255.0'; do
        grep -Fxq "$field" "$scratch/$role.ack"
    done
    ip -4 addr show eth0
    ip route
    ip -4 addr show eth0 | grep -Eq 'inet 10\.0\.2\.15/24 '
done
printf 'dhcp-normal:PASS:original-and-optimized-ACK-address-with-syslog\n'
printf 'dhcp-normal:scope:restricted-reference-NAT; gateway-and-DNS-not-advertised\n'
