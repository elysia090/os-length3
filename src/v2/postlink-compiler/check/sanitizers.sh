#!/usr/bin/env bash
set -euo pipefail

mode=${1:-address,undefined}
case "$mode" in
  address,undefined) checks=(select-x86-check selector-reentrancy-check selection-policy-check
    compiler-boundaries-check
    physical-check block-observation-check slice-observation-check
    shift-width-check native-closure-check) ;;
  thread) checks=(selector-reentrancy-check) ;;
  *) printf 'unsupported sanitizer mode: %s\n' "$mode" >&2; exit 2 ;;
esac

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
# An independent source/build tree also instruments the decoder and ELF
# reader. Production objects and distribution checkpoints are never replaced.
tar -C "$root" --exclude=build --exclude=.git \
  -cf - support x86 optimized-x86 postlink-compiler | tar -C "$temporary" -xf -
export ASAN_OPTIONS=halt_on_error=1:detect_leaks=1
export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
export TSAN_OPTIONS=halt_on_error=1
flags="-O1 -g -fno-omit-frame-pointer -fsanitize=$mode -fno-sanitize-recover=all"
for provider in support x86 optimized-x86; do
  make -C "$temporary/$provider" -j2 CFLAGS="$flags" all
done
if [[ $mode == address,undefined ]]; then
  make -C "$temporary/x86" CFLAGS="$flags" vector-projection-check
fi
make -C "$temporary/support" CFLAGS="$flags" arena-check
make -C "$temporary/postlink-compiler" -j2 CFLAGS="$flags" "${checks[@]}"
