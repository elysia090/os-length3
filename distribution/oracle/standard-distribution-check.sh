#!/bin/sh
# Common offline workload for both normally booted projections. Retain results
# in an isolated /run tmpfs directory; no user workspace or issuer is changed.
set -eu
input=${1:?test input directory}
work=$(mktemp -d /run/distribution-check.XXXXXXXX)
# The nobody reader must traverse this newly owned fixture parent as well as
# the userland subdirectory; no user file or system permission is changed.
chmod 0755 "$work"
sh "$input/browser-userland-check.sh" "$work/userland" all "$input/permission-reader.c"
cd "$work"
printf '%s\n' '#include <stdio.h>' 'int main(void) { puts("standard-distribution-42"); return 0; }' > hello.c
printf 'all:\n\tcc hello.c -o hello\n' > Makefile
make -s -j4
test "$(./hello)" = standard-distribution-42
mkdir git-fixture
cp hello.c Makefile git-fixture/
git -C git-fixture init -q
git -C git-fixture add hello.c Makefile
git -C git-fixture -c user.name=Oracle -c user.email=oracle@example.invalid commit -qm fixture
test "$(git -C git-fixture rev-list --count HEAD)" = 1
test -z "$(git -C git-fixture status --porcelain)"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:isolated-test-only -in hello.c -out hello.enc
openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:isolated-test-only -in hello.enc -out hello.dec
cmp hello.c hello.dec
apk info musl > package.txt
grep -q musl package.txt
tar -cf archive.tar hello.c Makefile
mkdir archive-roundtrip
tar -xf archive.tar -C archive-roundtrip
cmp hello.c archive-roundtrip/hello.c
cmp Makefile archive-roundtrip/Makefile
printf 'standard-distribution:PASS:shell-files-permissions-process-archive-ELF-C-make-git-AES-package\n'
printf 'standard-distribution:WORK:%s\n' "$work"
sha256sum hello.c hello hello.enc hello.dec archive.tar
