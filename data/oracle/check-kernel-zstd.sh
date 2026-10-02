#!/bin/sh
set -eu
if [ "$#" -ne 4 ]; then
    printf 'usage: %s KBUILD POSTLINK-COMPILER POSTLINK-VERIFY PAYLOAD\n' "$0" >&2
    exit 2
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build=$(realpath -e -- "$1")
compiler=$(realpath -e -- "$2")
verify=$(realpath -e -- "$3")
payload=$(realpath -e -- "$4")
scratch=${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}
temporary=$(mktemp -d "$scratch/.kernel-zstd.XXXXXXXX")
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM

# Link the same objects used by this kernel, not a rebuilt userspace Zstd
# version or modified source. This isolates native compiler semantics from
# the filesystem, kernel allocation and boot wrapper; it does not certify boot.
${CC:-cc} -O2 -std=c11 -Wall -Wextra -Wconversion -no-pie -Wl,--emit-relocs \
    "$here/kernel-zstd-readback.c" "$build"/lib/zstd/decompress/*.o \
    "$build"/lib/zstd/common/*.o "$build/lib/xxhash.o" \
    -o "$temporary/linked"
"$compiler" "$temporary/linked" -o "$temporary/optimized"
"$verify" "$temporary/linked" "$temporary/optimized"

mkdir -p "$temporary/root/bin"
cp -- "$payload" "$temporary/root/bin/busybox"
mksquashfs "$temporary/root" "$temporary/root.squashfs" -noappend \
    -all-root -comp zstd -processors 1 -mkfs-time 0 -no-progress >/dev/null
for table in inode directory; do
    "$temporary/linked" "$temporary/root.squashfs" "$table" "$temporary/source.$table"
    "$temporary/optimized" "$temporary/root.squashfs" "$table" "$temporary/optimized.$table"
    test -s "$temporary/source.$table"
    cmp "$temporary/source.$table" "$temporary/optimized.$table"
done
zstd -q "$payload" -o "$temporary/input.zst"
"$temporary/linked" "$temporary/input.zst" stream "$temporary/source.bytes"
"$temporary/optimized" "$temporary/input.zst" stream "$temporary/optimized.bytes"
cmp "$payload" "$temporary/source.bytes"
cmp "$temporary/source.bytes" "$temporary/optimized.bytes"

# A signal or a false success on malformed input is not an equivalent error.
# Compare the ordinary error return, diagnostics and any prefix already written.
expect_stream_failure() {
    input=$1
    if "$temporary/linked" "$input" stream "$temporary/source.failure" \
        2>"$temporary/source.error"; then
        source_status=0
    else
        source_status=$?
    fi
    if "$temporary/optimized" "$input" stream "$temporary/optimized.failure" \
        2>"$temporary/optimized.error"; then
        optimized_status=0
    else
        optimized_status=$?
    fi
    if [ "$source_status" -ne 1 ] || [ "$optimized_status" -ne 1 ]; then
        printf 'kernel Zstd error parity: red (%s: linked=%s optimized=%s)\n' \
            "$input" "$source_status" "$optimized_status" >&2
        exit 1
    fi
    cmp "$temporary/source.failure" "$temporary/optimized.failure"
    cmp "$temporary/source.error" "$temporary/optimized.error"
}
printf 'not a Zstandard frame\n' >"$temporary/bad-magic.zst"
expect_stream_failure "$temporary/bad-magic.zst"
input_bytes=$(stat -c %s -- "$temporary/input.zst")
test "$input_bytes" -gt 1
head -c "$((input_bytes - 1))" "$temporary/input.zst" >"$temporary/truncated.zst"
expect_stream_failure "$temporary/truncated.zst"
printf 'kernel Zstd objects: green (metadata/paged bytes and malformed/truncated error parity)\n'
