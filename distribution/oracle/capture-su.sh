#!/bin/sh
# Capture the exact shipped ELF and environment before minimizing a native red.
set -eu
printf 'su-capture-elf-begin\n'
sha256sum /usr/bin/su
base64 /usr/bin/su
printf 'su-capture-elf-end\n'
printf 'su-capture-environment-begin\n'
env | sort
id
printf 'su-capture-environment-end\n'
set +e
su -s /bin/sh nobody -c 'id'
status=$?
set -e
printf 'su-capture-status:%s\n' "$status"
test "$status" = 139
