#!/bin/sh
# Run only after sync, host flush, Worker destruction and a fresh normal boot.
set -eu
work=${1:?usage: browser-userland-restore.sh WORKSPACE}
cd "$work"
sha256sum -c expected.sha256
sha256sum -c expected.elf.sha256
stat -c '%a %h %n' private.txt hard.txt symbolic.txt payload.bin stored-program >actual.metadata
cmp expected.metadata actual.metadata
test "$(find small -type f | wc -l | tr -d ' ')" = 128
test "$(stat -c %i private.txt)" = "$(stat -c %i hard.txt)"
test "$(readlink symbolic.txt)" = private.txt
cmp symbolic.txt hard.txt
set +e
./stored-program
status=$?
set -e
test "$status" = 7
printf 'restore-receipt-begin\n'
sha256sum stdout.txt stderr.txt text.txt 'space name.txt' private.txt hard.txt payload.bin small/item-*
cat actual.metadata
sha256sum stored-program
printf 'restore-receipt-end\nrestored-program-exit:%s\n' "$status"
# expected.sha256 and expected.metadata must also match the guest-external copy.
printf 'userland-check:PASS:cold-restore:%s\n' "$work"
