#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
export ASAN_OPTIONS=halt_on_error=1:detect_leaks=1
export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
flags='-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all'
# Alternate build only; use the product source/dependency definition and
# preserve ordinary native objects and distribution/boot checkpoints.
make -j4 -C "$root" BUILD="$temporary" CFLAGS="$flags" \
    "$temporary/clock-check" "$temporary/pit-check" "$temporary/pic-check" \
    "$temporary/rtc-check" "$temporary/uart-check" "$temporary/execution-check" \
    "$temporary/source-banks-check" "$temporary/word-access-check" "$temporary/mmu-check" "$temporary/memory-check"
for test in clock pit pic rtc uart execution source-banks word-access mmu memory;do "$temporary/$test-check";done
