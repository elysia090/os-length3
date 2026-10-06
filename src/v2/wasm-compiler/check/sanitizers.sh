#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d /tmp/length3-compiler-sanitizer-XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
# One product source/dependency definition, with separate instrumented objects.
# No ordinary build, published bundle or retained browser fixture is replaced.
tar -C "$root" --exclude=build -cf - support x86 optimized-x86 machine-abi wasm-compiler |
    tar -C "$temporary" -xf -
export ASAN_OPTIONS=halt_on_error=1:detect_leaks=1
export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
flags='-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all'
for product in support x86 optimized-x86;do make -j4 -C "$temporary/$product" CFLAGS="$flags" all;done
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" \
    build/segment-load-check build/system-segments-check build/code-cut-check build/literal-check
for test in segment-load system-segments code-cut literal;do "$temporary/wasm-compiler/build/$test-check";done
