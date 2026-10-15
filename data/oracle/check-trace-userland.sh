#!/bin/sh
# Build and exercise the Linux observer on an independent CPU. This helper is
# test-only; it is never included in a release or used to execute guest code.
set -eu
scratch=$(mktemp -d /tmp/trace-userland.XXXXXXXX)
# The product profile does not use the reference image's /lib loader path.
# Keep this independent observer self-contained instead of copying an oracle
# interpreter into the guest or changing any signed runtime file.
cc -static -O2 -Wall -Wextra -Werror data/oracle/trace-userland.c -o "$scratch/trace"
"$scratch/trace" --fault-only /bin/true >"$scratch/true.log"
grep -Fxq 'oracle-trace exit=0' "$scratch/true.log"
set +e
"$scratch/trace" --fault-only /bin/sh -c 'exit 7' >"$scratch/exit.log"
exit_status=$?
"$scratch/trace" --fault-only /bin/sh -c 'kill -SEGV $$' >"$scratch/fault.log"
fault_status=$?
"$scratch/trace" --fault-only >"$scratch/usage.log" 2>&1
usage_status=$?
set -e
test "$exit_status" = 7
test "$fault_status" = 139
test "$usage_status" = 2
grep -Fxq 'oracle-trace exit=7' "$scratch/exit.log"
grep -Eq '^oracle-trace fault signal=11 address=.* rip=[0-9a-f]+ rsp=[0-9a-f]+ rbp=[0-9a-f]+ rax=[0-9a-f]+ rbx=[0-9a-f]+ ' "$scratch/fault.log"
grep -Fxq 'oracle-trace signal=11' "$scratch/fault.log"
cat "$scratch/true.log" "$scratch/exit.log" "$scratch/fault.log"
printf 'oracle-elf-begin trace-userland %s\n' "$(sha256sum "$scratch/trace" | cut -d ' ' -f 1)"
zstd -q -c "$scratch/trace" | base64
printf 'oracle-elf-end\n'
printf 'trace-userland:PASS:exit-fault-and-usage\n'
