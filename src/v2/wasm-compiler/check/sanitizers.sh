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
make -j4 -C "$temporary/x86" CFLAGS="$flags" build/unsigned-divide-check
"$temporary/x86/build/unsigned-divide-check"
make -j4 -C "$temporary/vm" CFLAGS="$flags" build/io-check
"$temporary/vm/build/io-check"
make -j4 -C "$temporary/vm" CFLAGS="$flags" build/exception-check
"$temporary/vm/build/exception-check"
make -j4 -C "$temporary/vm" CFLAGS="$flags" build/return-widths-check
"$temporary/vm/build/return-widths-check"
make -j4 -C "$temporary/vm" CFLAGS="$flags" build/descriptor-query-check
"$temporary/vm/build/descriptor-query-check"
make -j4 -C "$temporary/vm" CFLAGS="$flags" build/far-transfer-check
"$temporary/vm/build/far-transfer-check"
make -j4 -C "$temporary/artifact" CFLAGS="$flags" build/index-stream-check
"$temporary/artifact/build/index-stream-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" \
    build/segment-load-check build/system-segments-check build/code-cut-check build/literal-check build/source-module-check build/quotient-cap-check build/image-check build/image-module-check build/image-stream-check build/x87-snapshot-check build/x87-compare-check build/x87-integer-check build/x87-arithmetic-check build/x87-register-check build/x87-status-check build/enter-check build/string-io-check
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/software-interrupt-check
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/x87-wait-check
"$temporary/wasm-compiler/build/x87-wait-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/x87-stack-check
"$temporary/wasm-compiler/build/x87-stack-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/divide-check
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/return-check
"$temporary/wasm-compiler/build/return-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/packed-binary-check build/mmx-transfer-check
"$temporary/wasm-compiler/build/packed-binary-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/vector-integer-float-check
"$temporary/wasm-compiler/build/vector-integer-float-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/vector-float-integer-check
"$temporary/wasm-compiler/build/vector-float-integer-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/scalar-projection-check
"$temporary/wasm-compiler/build/scalar-projection-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/float-compare-check
"$temporary/wasm-compiler/build/float-compare-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/selector-query-check
"$temporary/wasm-compiler/build/selector-query-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/scalar-vector-transfer-check
"$temporary/wasm-compiler/build/scalar-vector-transfer-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/cr0-clear-check
"$temporary/wasm-compiler/build/cr0-clear-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/far-transfer-check
"$temporary/wasm-compiler/build/far-transfer-check"
"$temporary/wasm-compiler/build/mmx-transfer-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/flags-low-check
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/translate-byte-check
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/x87-integer-store-check
"$temporary/wasm-compiler/build/x87-integer-store-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/x87-float-store-check
"$temporary/wasm-compiler/build/x87-float-store-check"
make -j4 -C "$temporary/wasm-compiler" CFLAGS="$flags" build/x87-load-view-check
"$temporary/wasm-compiler/build/x87-load-view-check"
"$temporary/wasm-compiler/build/translate-byte-check"
"$temporary/wasm-compiler/build/flags-low-check"
"$temporary/wasm-compiler/build/divide-check"
for test in segment-load system-segments code-cut literal source-module quotient-cap x87-snapshot x87-compare x87-integer x87-arithmetic x87-register x87-status enter string-io software-interrupt;do "$temporary/wasm-compiler/build/$test-check";done
if [[ -n ${LENGTH3_IMAGE_INPUT:-} ]];then
    "$temporary/wasm-compiler/build/image-check" "$LENGTH3_IMAGE_INPUT"
    "$temporary/wasm-compiler/build/image-module-check" "$LENGTH3_IMAGE_INPUT"
fi
if [[ -n ${LENGTH3_STREAM_INPUT:-} ]];then "$temporary/wasm-compiler/build/image-stream-check" "$LENGTH3_STREAM_INPUT";fi
