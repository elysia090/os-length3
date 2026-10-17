#!/bin/sh
# Run inside the normally booted guest. Keep the directory for cold-reboot checks.
set -eu
umask 022
work=${1:-$(mktemp -d /workspace/userland-check.XXXXXXXX)}
group=${2:-all}
permission_source=${3:-/workspace/permission-reader.c}
script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
mkdir -p "$work"
cd "$work"
fail() { printf 'userland-check:FAIL:%s\n' "$*" >&2; exit 1; }
equal() { test "$1" = "$2" || fail "$3: expected [$2], got [$1]"; }
passed() { printf 'userland-check:PASS:%s\n' "$1"; }

# A pipeline's last status is not proof that every earlier command succeeded.
shell_check() {
set +e
sh -c 'printf "child-out\n"; printf "child-err\n" >&2; exit 7' >stdout.txt 2>stderr.txt
status=$?
set -e
equal "$status" 7 child-exit
equal "$(cat stdout.txt)" child-out child-stdout
equal "$(cat stderr.txt)" child-err child-stderr
printf 'keep 2\ndrop 99\nkeep 5\n' >text.txt
equal "$(grep '^keep ' text.txt | sed 's/keep /value /' | awk '{s += $2} END {print s}')" 7 pipeline-output
set +e
sh -c 'exit 7' | cat >pipeline.txt
status=$?
sh -c 'set -o pipefail; sh -c "exit 7" | cat' >pipefail.txt 2>pipefail.err
pipe_status=$?
grep not-present text.txt >/dev/null
grep_status=$?
grep keep no-such-input >/dev/null 2>grep.err
grep_error=$?
set -e
equal "$status" 0 last-command-status
equal "$pipe_status" 7 intermediate-failure
equal "$grep_status" 1 grep-no-match
equal "$grep_error" 2 grep-missing-input
equal "$(sed -n '2p' text.txt)" 'drop 99' sed-address
equal "$(awk '$1 == "keep" {print $2 * 2}' text.txt)" "$(printf '4\n10')" awk-output
passed shell-and-text
}

files_check() {
printf 'first\n' >'space name.txt'
printf 'second\n' >>'space name.txt'
cp 'space name.txt' 'copy name.txt'
cmp 'space name.txt' 'copy name.txt'
mv 'copy name.txt' 'renamed name.txt'
cmp 'space name.txt' 'renamed name.txt'
rm 'renamed name.txt'
test ! -e 'renamed name.txt' || fail remove
mkdir small
i=0
while test "$i" -lt 128; do
    printf 'file:%03d:nonzero\n' "$i" >"small/item-$(printf '%03d' "$i")"
    i=$((i+1))
done
equal "$(find small -type f | wc -l | tr -d ' ')" 128 small-file-count
find small -type f | LC_ALL=C sort >small.names
sha256sum small/item-* >small.sha256
# 4096 identical nonzero 256-byte records: independent expected hash is host-side.
awk 'BEGIN {s=""; for(j=0;j<16;j++) s=s "0123456789abcdef"; for(i=0;i<4096;i++) printf "%s",s}' >payload.bin
equal "$(wc -c <payload.bin | tr -d ' ')" 1048576 large-file-size
sha256sum payload.bin >payload.sha256
passed files
}

# Root must not be the reader in the permission test.
permissions_check() {
uid=$(awk -F: '$1 == "nobody" {print $3}' /etc/passwd)
gid=$(awk -F: '$1 == "nobody" {print $4}' /etc/passwd)
test -n "$uid" && test "$uid" != 0 || fail nonprivileged-uid
test -n "$gid" && test "$gid" != 0 || fail nonprivileged-gid
chmod 755 "$work"
printf 'permission-proof\n' >private.txt
chmod 600 private.txt
cc -Wall -Wextra -Werror "$permission_source" -o permission-reader
./permission-reader deny "$work/private.txt" >denied.out
grep -qx "permission-reader:uid=$uid gid=$gid" denied.out
chmod 644 private.txt
./permission-reader allow "$work/private.txt" >allowed.out
grep -qx "permission-reader:uid=$uid gid=$gid" allowed.out
grep -qx permission-reader:content=verified allowed.out
passed permissions
}

links_check() {
printf 'permission-proof\n' >private.txt
chmod 644 private.txt
ln private.txt hard.txt
ln -s private.txt symbolic.txt
equal "$(stat -c %i private.txt)" "$(stat -c %i hard.txt)" hardlink-inode
equal "$(stat -c %h private.txt)" 2 hardlink-count
printf 'shared-update\n' >>hard.txt
cmp private.txt hard.txt
cmp private.txt symbolic.txt
equal "$(readlink symbolic.txt)" private.txt symlink-target
passed links
}

process_check() {
sh -c 'exit 7' & first=$!
sh -c 'exit 9' & second=$!
set +e
wait "$first"; first_status=$?
wait "$second"; second_status=$?
set -e
equal "$first_status" 7 first-child
equal "$second_status" 9 second-child
printf '%s\n' '#!/bin/sh' "trap 'echo term-trapped >term.receipt; exit 23' TERM" ': >term.ready' 'while :; do sleep 1; done' >term-child.sh
sh term-child.sh & child=$!
n=0
until test -f term.ready; do n=$((n+1)); test "$n" -lt 20 || fail trap-ready; sleep 1; done
kill -TERM "$child"
set +e
wait "$child"; status=$?
set -e
equal "$status" 23 term-child-exit
equal "$(cat term.receipt)" term-trapped term-trap
passed process-and-signal
}

archive_check() {
mkdir archive-source archive-restored
cp private.txt archive-source/data
chmod 640 archive-source/data
ln archive-source/data archive-source/hard
ln -s data archive-source/symbolic
cp 'space name.txt' 'archive-source/space name.txt'
(cd archive-source; sha256sum data hard 'space name.txt') >archive.expected
tar -czf roundtrip.tar.gz -C archive-source .
gzip -t roundtrip.tar.gz
tar -xzf roundtrip.tar.gz -C archive-restored
(cd archive-restored; sha256sum -c ../archive.expected)
equal "$(stat -c %a archive-restored/data)" 640 archive-mode
equal "$(stat -c %i archive-restored/data)" "$(stat -c %i archive-restored/hard)" archive-hardlink
equal "$(readlink archive-restored/symbolic)" data archive-symlink
cmp archive-restored/data archive-restored/symbolic
passed tar-gzip
}

elf_check() {
printf 'int main(void){return 7;}\n' >stored-program.c
cc stored-program.c -o stored-program
set +e
./stored-program
program_status=$?
set -e
equal "$program_status" 7 stored-program-exit
sha256sum stored-program >expected.elf.sha256
passed stored-elf
}

# Canonical text receipts can be copied outside the guest before Worker teardown.
receipt_check() {
sha256sum stdout.txt stderr.txt text.txt 'space name.txt' private.txt hard.txt payload.bin >expected.sha256
cat small.sha256 >>expected.sha256
stat -c '%a %h %n' private.txt hard.txt symbolic.txt payload.bin stored-program >expected.metadata
printf 'expected-receipt-begin\n'
cat expected.sha256 expected.metadata expected.elf.sha256
printf 'expected-receipt-end\n'
sync
printf 'userland-check:PASS:sync\nuserland-check:WORKSPACE:%s\n' "$work"
}

case "$group" in
shell) shell_check;;
files) files_check;;
permissions) permissions_check;;
links) links_check;;
process) process_check;;
archive) archive_check;;
elf) elf_check;;
receipt) receipt_check;;
all)
    failed=0
    for part in shell files permissions links process archive elf receipt; do
        # An independent shell preserves errexit within each group. Wrapping
        # a shell function in an if/&& condition would silently disable it.
        set +e
        sh "$script" "$work" "$part" "$permission_source"
        status=$?
        set -e
        printf 'userland-check:RESULT:%s:%s\n' "$part" "$status"
        if test "$status" != 0; then failed=1; fi
    done
    test "$failed" = 0 || exit 1
    printf 'userland-check:PASS:all\n'
    ;;
*) fail unknown-group;;
esac
