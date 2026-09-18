#!/bin/sh
set -eu

export PATH=/usr/bin:/usr/sbin:/bin:/sbin

for tool in cc gcc cpp as ld ar ranlib nm objcopy objdump readelf strip \
    make git curl tar gzip xz bzip2 patch file pkg-config ssh; do
    path="/usr/bin/$tool"
    test -x "$path"
    printf 'TOOL %s %s\n' "$tool" "$path"
done

test -r /usr/include/stdio.h
test -r /usr/include/linux/version.h
test -r /usr/lib/libc.a
test -r /etc/ssl/certs/ca-certificates.crt

cat >/tmp/qm-toolchain.c <<'EOF'
#include <stdio.h>
#include <linux/version.h>

int main(void)
{
    printf("QM-C-OK %d\n", LINUX_VERSION_CODE != 0);
    return 0;
}
EOF

/usr/bin/gcc -O0 -static /tmp/qm-toolchain.c -o /tmp/qm-toolchain
/tmp/qm-toolchain
/usr/bin/file /tmp/qm-toolchain
/usr/bin/readelf -h /tmp/qm-toolchain | grep 'X86-64'

/usr/bin/make -j8 -f /opt/qm/Makefile

rm -rf /tmp/qm-git
mkdir /tmp/qm-git
cd /tmp/qm-git
/usr/bin/git init -q
printf 'guest git\n' >README
/usr/bin/git add README
/usr/bin/git -c user.name=QM -c user.email=qm.invalid commit -qm bootstrap
/usr/bin/git rev-parse --verify HEAD

/usr/bin/pkg-config --exists zlib openssl libcurl
/usr/bin/curl --version
/usr/bin/ssh -V 2>&1

printf 'archive round trip\n' >/tmp/qm-archive
/usr/bin/tar -czf /tmp/qm-archive.tar.gz -C /tmp qm-archive
rm /tmp/qm-archive
/usr/bin/tar -xzf /tmp/qm-archive.tar.gz -C /tmp
grep -q 'archive round trip' /tmp/qm-archive

printf '%s%s%s\n' 'TOOLCHAIN' '-AUDIT' '-OK'
