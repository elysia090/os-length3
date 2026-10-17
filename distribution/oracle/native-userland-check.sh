#!/bin/sh
# Independent CPU oracle. Browser acceptance is measured separately.
set -eu
cc -O2 -Wall -Wextra -Werror /tmp/oracle-inputs/trace-userland.c -o /tmp/oracle-inputs/trace-userland
set +e
/tmp/oracle-inputs/trace-userland /usr/bin/su -s /bin/sh nobody -c id
status=$?
set -e
printf 'native-userland:su-status:%s\n' "$status"
# Retain an explicit SU red while exercising unrelated userland contracts.
test "$status" = 0 || test "$status" = 139
sh /tmp/oracle-inputs/browser-userland-check.sh /workspace/native-userland all /tmp/oracle-inputs/permission-reader.c
sh /tmp/oracle-inputs/browser-apk-check.sh /workspace/native-apk
