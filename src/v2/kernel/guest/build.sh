#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: $0 WASMLINUX_ROOT OUTPUT.wasm" >&2
    exit 2
fi

linux_root=$1
output_dir=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)
output=$output_dir/$(basename -- "$2")
guest_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_root=$(mktemp -d /tmp/qm-lkl-guest.XXXXXX)
trap 'rm -rf "$build_root"' EXIT HUP INT TERM
header_root=$build_root/include
llvm_root=$(dirname -- "$(readlink -f "$linux_root/host/bin/llvm-ranlib")")

generated_syscalls=$linux_root/lkl-wasm/arch/lkl/include/generated/uapi/asm/syscall_defs.h
mkdir -p "$(dirname -- "$generated_syscalls")"
"$llvm_root/llvm-ar" t "$linux_root/lkl-wasm/vmlinux.a" \
    > "$build_root/kernel-objects.txt"
/run/current-system/sw/bin/python3 "$guest_root/extract_syscall_defs.py" \
    --thin-list "$linux_root/lkl-wasm" "$build_root/kernel-objects.txt" \
    > "$generated_syscalls"

(
    cd "$linux_root/lkl-wasm"
    env srctree="$linux_root/lkl-wasm" objtree="$linux_root/lkl-wasm" \
        /run/current-system/sw/bin/python3 \
        arch/lkl/scripts/headers_install.py -j1 "$header_root" \
        > "$build_root/header-install.log"
)

sed -i \
    -e 's/long lkl_syscall(long no, long \*params);/long lkl_syscall(long no, int nargs, long *params);/' \
    -e 's/lkl_syscall(__lkl__NR##name, params)/lkl_syscall(__lkl__NR##name, 0, params)/' \
    -e 's/lkl_syscall(__lkl__NR##name, sys_params)/lkl_syscall(__lkl__NR##name, x, sys_params)/' \
    -e 's/lkl_syscall(__lkl__NR##name, lkl_params)/lkl_syscall(__lkl__NR##name, x, lkl_params)/' \
    "$header_root/lkl/asm/syscalls.h"

tools_include=$build_root/tools-include
mkdir -p "$tools_include"
cp "$linux_root/lkl-wasm/tools/lkl/include/lkl.h" "$tools_include/"
cp "$linux_root/lkl-wasm/tools/lkl/include/lkl_host.h" "$tools_include/"
cp "$linux_root/lkl-wasm/tools/lkl/include/lkl_autoconf.h" "$tools_include/"
cp "$linux_root/lkl-wasm/tools/lkl/include/lkl_config.h" "$tools_include/"
cp "$linux_root/lkl-wasm/tools/lkl/include/kernel_config.h" "$tools_include/"
sed -i \
    's/lkl_syscall(__lkl__NR_nanosleep, p)/lkl_syscall(__lkl__NR_nanosleep, 2, p)/' \
    "$tools_include/lkl.h"

stub_root=$linux_root/runner/kmwrap/stubs
cp "$stub_root/hostwasm_main.c" "$build_root/"
cp "$stub_root/hostwasm_lklops.c" "$build_root/"
cp "$stub_root/hostwasm_nisys.c" "$build_root/"
cp "$stub_root/initsyms.gen.c" "$build_root/"
cp "$stub_root/initschedclasses.o" "$build_root/"
patch -d "$build_root" -p1 -i "$guest_root/hostwasm.patch"

cd "$build_root"
"$linux_root/_toolchain/bin/warp-cc" \
    -O2 -g0 -mbulk-memory -nostdlib -Wl,--no-entry -Wl,--strip-debug \
    -Wl,--error-limit=0 \
    -D_GNU_SOURCE -DLKL_HOST_CONFIG_POSIX=1 \
    -include sys/types.h -include time.h \
    -Wl,"--Map=$output.map" -o "$output" \
    -isystem "$linux_root/host/lib/clang/18/include" \
    -isystem "$linux_root/prefix/include" \
    -I "$tools_include" \
    -I "$header_root" \
    -I "$linux_root/lkl-wasm/include" \
    -I "$linux_root/lkl-wasm/include/uapi" \
    -I "$linux_root/lkl-wasm/arch/lkl/include" \
    -I "$linux_root/lkl-wasm/arch/lkl/include/generated" \
    -I "$linux_root/lkl-wasm/arch/lkl/include/generated/uapi" \
    -I "$linux_root/lkl-wasm/tools/lkl/include" \
    "$linux_root/lkl-wasm/lib/lib.a" \
    "$linux_root/lkl-wasm/vmlinux.a" \
    initschedclasses.o hostwasm_main.c hostwasm_lklops.c \
    hostwasm_nisys.c initsyms.gen.c "$guest_root/block.c" \
    "$linux_root/lkl-wasm/tools/lkl/lib/virtio.c" \
    "$linux_root/lkl-wasm/tools/lkl/lib/virtio_blk.c" \
    "$linux_root/lkl-wasm/tools/lkl/lib/iomem.c" \
    "$linux_root/lkl-wasm/tools/lkl/lib/fs.c"

echo "$output"
