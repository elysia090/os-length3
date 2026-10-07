#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d /tmp/length3-compiler-sanitizer-XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
# One product source/dependency definition, with separate instrumented objects.
# No ordinary build, published bundle or retained browser fixture is replaced.
tar -C "$root" --exclude=build --exclude=generated --exclude='generated-startup*' -cf - support x86 optimized-x86 machine-abi wasm-compiler vm artifact |
    tar -C "$temporary" -xf -
export ASAN_OPTIONS=halt_on_error=1:detect_leaks=1
export UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
flags='-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all'
for product in support x86 optimized-x86;do make -j4 -C "$temporary/$product" CFLAGS="$flags" all;done
make -j4 -C "$temporary/artifact" CFLAGS="$flags" build/index-stream-check
"$temporary/artifact/build/index-stream-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" \
    build/segment-load-check build/system-segments-check build/code-cut-check build/literal-check build/source-module-check build/quotient-cap-check build/image-check build/image-module-check build/image-stream-check build/x87-snapshot-check build/x87-compare-check build/x87-integer-check
for test in segment-load system-segments code-cut literal source-module quotient-cap x87-snapshot x87-compare x87-integer;do "$temporary/wasm-compiler/build/$test-check";done
if [[ -n ${LENGTH3_IMAGE_INPUT:-} ]];then
    "$temporary/wasm-compiler/build/image-check" "$LENGTH3_IMAGE_INPUT"
    "$temporary/wasm-compiler/build/image-module-check" "$LENGTH3_IMAGE_INPUT"
fi
if [[ -n ${LENGTH3_STREAM_INPUT:-} ]];then "$temporary/wasm-compiler/build/image-stream-check" "$LENGTH3_STREAM_INPUT";fi
