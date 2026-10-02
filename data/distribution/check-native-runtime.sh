#!/usr/bin/env bash
set -euo pipefail

if [[ $# == 2 && $1 == --inside ]]; then
  root=$(realpath -e -- "$2")
  mount --bind "$root" "$root"
  mount -o remount,bind,ro "$root"
  mount --bind /dev "$root/dev"
  mount -t proc proc "$root/proc"
  mount -t tmpfs -o size=128m,mode=1777 tmpfs "$root/tmp"
  mount -t tmpfs -o size=128m,mode=0700 tmpfs "$root/root"
  # All mounts disappear with this private namespace. Only scratch and the
  # project home are writable; the candidate release root stays immutable.
  env -i PATH=/usr/bin:/usr/sbin:/bin:/sbin HOME=/root \
    QM_NATIVE_TRACE="${QM_NATIVE_TRACE:-0}" \
    chroot "$root" /bin/sh -e -s <<'GUEST'
PATH=/usr/bin:/usr/sbin:/bin:/sbin
HOME=/root
export PATH HOME
if [ "${QM_NATIVE_TRACE:-0}" = 1 ]; then set -x; fi
# Resolve the real offline service graph before development checks. This is
# not PID 1 or boot validation, but it catches a broken installed CLI/DB pair
# without constructing a second service database or reaching the network.
services=$(hexdump -v -n 8 -e '1/1 "%u\n"' /etc/s6-rc/compiled/current/n | \
  awk '{for(i=1;i<=NF;i++) {if(++j==5) {a=n;n=0} n=256*n+$i}}
       END {if(j!=8 || n+a<1 || n+a>65536) exit 1; print n+a}')
mkdir /tmp/s6-rc-live
ln -s /etc/s6-rc/compiled/current /tmp/s6-rc-live/compiled
dd if=/dev/zero of=/tmp/s6-rc-live/state bs="$services" count=1 2>/dev/null
s6-rc --no-lock -l /tmp/s6-rc-live -u listall interactive-ready \
  >/tmp/offline-services
sort /tmp/offline-services >/tmp/offline-services.sorted
printf '%s\n' coldplug interactive-ready mdevd-ready \
  mount-api-filesystems root-and-workspace-ready s6rc-oneshot-runner \
  >/tmp/offline-services.expected
cmp -s /tmp/offline-services.expected /tmp/offline-services.sorted
cd "$HOME"
test "$(pwd)" = /root
printf '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }\n' >hello.c
printf 'all:\n\tcc hello.c -o hello\n' >Makefile
printf 'hello\n' >.gitignore
make -s -j4
test "$(./hello)" = hello
git init -q
git add hello.c Makefile .gitignore
git -c user.name=Smoke -c user.email=smoke@example.invalid \
  commit -qm initial
test -z "$(git status --porcelain)"
/usr/bin/[ 1 -eq 1 ]
printf '#include <stdio.h>\nint main(void) { puts("native-ready"); return 0; }\n' >/tmp/smoke.c
/usr/bin/cc /tmp/smoke.c -o /tmp/smoke
test "$(/tmp/smoke)" = native-ready
/usr/bin/file -b /tmp/smoke | grep -q 'ELF 64-bit'
printf 'int answer(void) { return 42; }\n' >/tmp/answer.c
printf 'int answer(void); int main(void) { return answer() != 42; }\n' >/tmp/link.c
/usr/bin/cc -c /tmp/answer.c -o /tmp/answer.o
/usr/bin/ar rc /tmp/libanswer.a /tmp/answer.o
/usr/bin/ranlib /tmp/libanswer.a
/usr/bin/cc /tmp/link.c -L/tmp -lanswer \
  -Wl,--emit-relocs -o /tmp/link-static
/tmp/link-static
/usr/bin/readelf -h /tmp/link-static | grep -q 'ELF64'
/usr/bin/readelf -rW /tmp/link-static | grep -q 'R_X86_64_'
/usr/bin/objcopy -O binary /tmp/link-static /tmp/link-binary
test -s /tmp/link-binary
if /usr/bin/readelf -l /tmp/link-static | grep -q 'Requesting program interpreter'; then
  exit 1
fi
printf '#include <zlib.h>\n#include <string.h>\nint main(void) { const char in[]="abc"; unsigned char compressed[64]; char out[4]={0}; uLongf n=sizeof(compressed), m=3; if (compress2(compressed,&n,(const Bytef *)in,3,Z_BEST_COMPRESSION)!=Z_OK) return 1; if (uncompress((Bytef *)out,&m,compressed,n)!=Z_OK) return 2; return m!=3 || memcmp(in,out,3); }\n' >/tmp/zlib-smoke.c
/usr/bin/cc /tmp/zlib-smoke.c $(/usr/bin/pkgconf --static --libs zlib) -o /tmp/zlib-smoke
/tmp/zlib-smoke
/usr/bin/git init -q /tmp/smoke-repository
test -f /tmp/smoke-repository/.git/HEAD
/usr/bin/git -C /tmp/smoke-repository status --porcelain >/tmp/git-status
test ! -s /tmp/git-status
/bin/cp /tmp/smoke.c /tmp/smoke-repository/smoke.c
/usr/bin/git -C /tmp/smoke-repository add smoke.c
/usr/bin/git -C /tmp/smoke-repository -c user.name=Smoke \
  -c user.email=smoke@example.invalid commit -qm initial
/usr/bin/git clone -q /tmp/smoke-repository /tmp/smoke-clone
cmp -s /tmp/smoke.c /tmp/smoke-clone/smoke.c
test "$(/usr/bin/git -C /tmp/smoke-repository rev-parse HEAD)" = \
  "$(/usr/bin/git -C /tmp/smoke-clone rev-parse HEAD)"
printf 'all:\n\t/usr/bin/cc /tmp/smoke.c -o /tmp/made-smoke\ninstall: all\n\tmkdir -p $(DESTDIR)/usr/bin\n\tinstall -m 0755 /tmp/made-smoke $(DESTDIR)/usr/bin/made-smoke\n' >/tmp/Makefile
/usr/bin/make -s -j4 -C /tmp
test "$(/tmp/made-smoke)" = native-ready
/usr/bin/make -s -j4 -C /tmp install DESTDIR=/tmp/installed-root
test "$(/tmp/installed-root/usr/bin/made-smoke)" = native-ready
/usr/bin/tar -cf /tmp/smoke.tar -C /tmp/smoke-clone smoke.c
/usr/bin/gzip -c /tmp/smoke.tar >/tmp/smoke.tar.gz
/usr/bin/gunzip -c /tmp/smoke.tar.gz >/tmp/reopened.tar
/bin/mkdir /tmp/from-gzip
/usr/bin/tar -xf /tmp/reopened.tar -C /tmp/from-gzip
cmp -s /tmp/smoke.c /tmp/from-gzip/smoke.c
/usr/bin/zstd -q -c /tmp/smoke.tar >/tmp/smoke.tar.zst
/usr/bin/zstd -q -d -c /tmp/smoke.tar.zst >/tmp/reopened.tar
/bin/mkdir /tmp/from-zstd
/usr/bin/tar -xf /tmp/reopened.tar -C /tmp/from-zstd
cmp -s /tmp/smoke.c /tmp/from-zstd/smoke.c
for threads in 1 2 0; do
  /usr/bin/xz -T"$threads" -c /tmp/smoke.c >/tmp/smoke.xz
  /usr/bin/xz -dc /tmp/smoke.xz >/tmp/from-xz.c
  cmp -s /tmp/smoke.c /tmp/from-xz.c
done
/usr/bin/bzip2 -c /tmp/smoke.c >/tmp/smoke.bz2
/usr/bin/bzip2 -dc /tmp/smoke.bz2 >/tmp/from-bzip2.c
cmp -s /tmp/smoke.c /tmp/from-bzip2.c
dd if=/tmp/smoke.c of=/tmp/copied.c bs=1 2>/dev/null
diff -u /tmp/smoke.c /tmp/copied.c
install -m 0644 /tmp/smoke.c /tmp/installed.c
cmp -s /tmp/smoke.c /tmp/installed.c
getopt -o a -- -a | grep -q -- '-a --'
mkfifo /tmp/smoke-fifo
test -p /tmp/smoke-fifo
test "$(awk 'BEGIN { print 42 }')" = 42
test "$(printf abc | base64 | base64 -d)" = abc
test "$(whoami)" = root
test -n "$(printenv PATH)"
test -n "$(hostname)"
timeout 5 /tmp/smoke >/tmp/timed-smoke
test "$(/bin/cat /tmp/timed-smoke)" = native-ready
command -v od >/tmp/od-path
test "$(printf abc | hexdump -e '3/1 "%02x"')" = 616263
printf abc >/tmp/hash-input
sha256sum /tmp/hash-input | grep -q '^ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad '
cksum /tmp/hash-input >/tmp/cksum-output
/usr/bin/openssl dgst -sha256 /tmp/smoke.c >/tmp/smoke-digest
grep -q 'SHA2-256' /tmp/smoke-digest
# Exercise the installed arithmetic and cipher paths, not only CLI startup.
# Keys and ciphertext are scratch; the immutable release gains no test data.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out /tmp/signing-key.pem 2>/tmp/key-generation.log
openssl pkey -in /tmp/signing-key.pem -pubout -out /tmp/signing-public.pem
openssl dgst -sha256 -sign /tmp/signing-key.pem \
  -out /tmp/smoke.signature /tmp/smoke.c
openssl dgst -sha256 -verify /tmp/signing-public.pem \
  -signature /tmp/smoke.signature /tmp/smoke.c >/tmp/verified-signature
printf 'different message\n' >/tmp/different-message
if openssl dgst -sha256 -verify /tmp/signing-public.pem \
     -signature /tmp/smoke.signature /tmp/different-message \
     >/tmp/rejected-signature 2>&1; then
  exit 1
else
  # A synchronous fault is not a successful negative verification test.
  test "$?" -eq 1
fi
openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:runtime-test-only \
  -in /tmp/smoke.c -out /tmp/smoke.encrypted
openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:runtime-test-only \
  -in /tmp/smoke.encrypted -out /tmp/smoke.decrypted
cmp -s /tmp/smoke.c /tmp/smoke.decrypted
/usr/bin/pkgconf --version >/tmp/pkgconf-version
/usr/bin/apk info musl >/tmp/apk-info 2>/tmp/apk-error
grep -q musl /tmp/apk-info
test ! -s /tmp/apk-error
/usr/bin/curl --version >/tmp/curl-version
/usr/bin/curl -fsS file:///tmp/smoke.c >/tmp/curl-file
cmp -s /tmp/smoke.c /tmp/curl-file
/usr/bin/ssh -V >/tmp/ssh-version 2>&1
grep -q OpenSSH /tmp/ssh-version
ssh-keygen -q -t ed25519 -N '' -C runtime-test-only -f /tmp/ssh-key
ssh-keygen -y -f /tmp/ssh-key >/tmp/ssh-derived-public
# Compare the algorithm and key, independently of the optional comment.
awk '{print $1, $2}' /tmp/ssh-derived-public >/tmp/ssh-derived-key
awk '{print $1, $2}' /tmp/ssh-key.pub | cmp -s - /tmp/ssh-derived-key
ssh-keygen -l -f /tmp/ssh-key.pub >/tmp/ssh-fingerprint
grep -q ED25519 /tmp/ssh-fingerprint
GUEST
  printf 'native runtime: green (services, static C, make, file, Git history, archives, RSA/AES, apk, curl, ssh)\n'
  exit 0
fi

if [[ $# != 1 || ! -d $1 ]]; then
  printf 'usage: %s RELEASE_ROOT\n' "$0" >&2
  exit 2
fi
root=$(realpath -e -- "$1")
for directory in dev proc tmp; do
  if [[ ! -d $root/$directory ]]; then
    printf 'native runtime: missing mount point: %s\n' "$directory" >&2
    exit 1
  fi
done
if [[ $(id -u) != 0 ]]; then
  printf 'native runtime: private mount namespace requires root\n' >&2
  exit 1
fi
unshare --mount --propagation private bash "$0" --inside "$root"
