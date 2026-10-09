#!/bin/sh
# Locked official sources -> ordinary linker -> independent postlink product.
# These are oracle inputs, never substitutions for published release bytes.
set -eu
candidate_root=0
init_profile=0
kernel=0
for option;do case "$option" in --candidate-root)candidate_root=1;;--init-profile)init_profile=1;;--kernel)kernel=1;;*)exit 2;;esac;done
if [ "$init_profile" = 1 ] && [ "$candidate_root" != 1 ];then exit 2;fi
scratch=$(mktemp -d /tmp/length3-publication-XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
compiler=src/v2/postlink-compiler/build/postlink-compiler
verify=src/v2/optimized-x86/build/postlink-verify
receipt() { printf 'oracle-elf-begin %s %s\n' "$1" "$(sha256sum "$2" | cut -d ' ' -f 1)";zstd -q -c "$2" | base64;printf 'oracle-elf-end\n'; }
test -b /dev/vdd;test -b /dev/vde
. data/sources.env
mkdir -p "$scratch/source" "$scratch/tar-build"
tar -xJf /dev/vdd -C "$scratch/source"
tar -xjf /dev/vde -C "$scratch/source"
recipe_root=$PWD
cd "$scratch/tar-build"
FORCE_UNSAFE_CONFIGURE=1 CFLAGS=-O2 LDFLAGS='-static -Wl,--emit-relocs' \
    "$scratch/source/tar-$TAR_VERSION/configure" --disable-nls
make -j4
tar_input=$scratch/tar-build/src/tar
cd "$recipe_root"
mkdir -p "$scratch/input" "$scratch/original" "$scratch/optimized"
printf Q >"$scratch/input/a"
"$tar_input" --format=pax --pax-option=mtime:=0.25 -cf "$scratch/pax.tar" -C "$scratch/input" a
"$tar_input" -xf "$scratch/pax.tar" -C "$scratch/original"
cmp "$scratch/input/a" "$scratch/original/a"
"$compiler" "$tar_input" -o "$scratch/tar-optimized"
"$verify" "$tar_input" "$scratch/tar-optimized"
receipt tar-input "$tar_input"
receipt tar-optimized "$scratch/tar-optimized"
"$scratch/tar-optimized" -xf "$scratch/pax.tar" -C "$scratch/optimized"
cmp "$scratch/input/a" "$scratch/optimized/a"
printf 'userland publication: original/optimized GNU tar PAX green\n'
# Use the release's exact applet/profile population, not BusyBox defconfig.
# oldconfig may resolve compiler capabilities but must not change this lock.
cp "data/config/busybox-$BUSYBOX_VERSION.config" \
    "$scratch/source/busybox-$BUSYBOX_VERSION/.config"
KCONFIG_NOTIMESTAMP=1 make -C "$scratch/source/busybox-$BUSYBOX_VERSION" oldconfig </dev/null
cmp "data/config/busybox-$BUSYBOX_VERSION.config" \
    "$scratch/source/busybox-$BUSYBOX_VERSION/.config"
make -j4 -C "$scratch/source/busybox-$BUSYBOX_VERSION" busybox
busybox_input=$scratch/source/busybox-$BUSYBOX_VERSION/busybox_unstripped
cc -O2 -Wall -Wextra data/oracle/trace-userland.c -o "$scratch/trace"
printf R >"$scratch/original-one"
"$scratch/trace" "$busybox_input" mv "$scratch/original-one" "$scratch/original-two"
test ! -e "$scratch/original-one"
test "$(cat "$scratch/original-two")" = R
"$compiler" "$busybox_input" -o "$scratch/busybox-optimized"
"$verify" "$busybox_input" "$scratch/busybox-optimized"
receipt busybox-input "$busybox_input"
receipt busybox-optimized "$scratch/busybox-optimized"
printf R >"$scratch/one"
set +e
"$scratch/trace" "$scratch/busybox-optimized" mv "$scratch/one" "$scratch/two"
mv_status=$?
set -e
printf 'userland publication: optimized mv exit=%s\n' "$mv_status"
ls -l "$scratch/one" "$scratch/two" || :
test "$mv_status" = 0
test ! -e "$scratch/one"
test "$(cat "$scratch/two")" = R
printf 'userland publication: pristine tar PAX and BusyBox mv green\n'
if [ "$candidate_root" = 1 ];then
    # Isolated boot candidate only: package database/signatures are NOT
    # republished by this diagnostic. Preserve the immutable shipped inputs.
    unsquashfs -d "$scratch/candidate-root" /dev/vdf >/dev/null
    cat "$scratch/busybox-optimized" >"$scratch/candidate-root/bin/busybox"
    cat "$scratch/tar-optimized" >"$scratch/candidate-root/usr/bin/tar"
    if [ "$init_profile" = 1 ];then
        mkdir -p data/upstream "$scratch/init-output" "$scratch/init-forest"
        tar -xf /dev/vdi -C data/upstream
        # Reuse the authoritative recipe and package postlink transaction,
        # not another hand-written service build or opcode substitution.
        init_set=$(QM_INIT_BUILD_ROOT="$scratch/init-build" QM_OUTPUT_ROOT="$scratch/init-output" QM_JOBS=4 bash data/distribution/build-init.sh)
        test "$(head -n 1 "$init_set")" = package-root-set-v1
        tail -n +2 "$init_set" | while IFS="$(printf '\t')" read -r package root;do
            mkdir "$scratch/init-forest/$package"
            cp -al "$root/." "$scratch/init-forest/$package/"
        done
        make -j4 -C src/v2 all
        bash data/distribution/optimize-payload.sh "$scratch/init-forest" "$scratch/init-optimized" \
            src/v2/build/artifact-executable-stage "$verify"
        for package in "$scratch/init-optimized"/*;do
            bash data/distribution/clone-tree.sh "$package" "$scratch/candidate-root"
        done
        printf 'userland candidate: locked init profile rebuilt through authoritative recipe/postlink\n'
    fi
    roles='initramfs system.squashfs'
    if [ "$kernel" = 1 ];then
        # Reuse the official kernel recipe and Kbuild wrapper. No host/WSL
        # kernel or separately invented image enters this diagnostic.
        head -c "$LENGTH3_KERNEL_SOURCE_BYTES" /dev/vdj >"data/upstream/linux-$LINUX_VERSION.tar.xz"
        QM_LINKED_KERNEL_ROOT="$scratch/kernel-build" QM_JOBS=4 bash data/build-linked-kernel.sh bzImage
        kernel_build=$(find "$scratch/kernel-build/output" -mindepth 1 -maxdepth 1 -type d)
        test -f "$kernel_build/vmlinux.unstripped"
        "$compiler" "$kernel_build/vmlinux.unstripped" -o "$scratch/kernel-optimized.elf"
        "$verify" "$kernel_build/vmlinux.unstripped" "$scratch/kernel-optimized.elf"
        bash data/oracle/package-postlinked-kernel.sh "$scratch/kernel-optimized.elf" "$kernel_build" "$scratch/candidate.kernel"
        cat "$scratch/candidate.kernel" >"$scratch/candidate-root/boot/kernel"
        roles="kernel $roles"
    fi
    mkdir "$scratch/boot-root"
    (cd "$scratch/boot-root";cpio -id </dev/vdg)
    cat "$scratch/busybox-optimized" >"$scratch/boot-root/bin/busybox"
    (cd "$scratch/boot-root";find . -print0 | LC_ALL=C sort -z | cpio --null -o --format=newc --owner=0:0 --reproducible) >"$scratch/candidate.initramfs"
    mksquashfs "$scratch/candidate-root" "$scratch/candidate.system.squashfs" -noappend -comp zstd -processors 1 -mkfs-time 0 -no-progress >/dev/null
    mkdir "$scratch/output"
    output_device=/dev/vdh1
    if [ ! -b "$output_device" ];then output_device=/dev/vdh;fi
    mount -t vfat "$output_device" "$scratch/output"
    for role in $roles;do
        file=$scratch/candidate.$role
        cp "$file" "$scratch/output/$role"
        printf 'oracle-candidate %s %s %s\n' "$role" "$(wc -c <"$file" | tr -d ' ')" "$(sha256sum "$file" | cut -d ' ' -f 1)"
    done
    sync
    umount "$scratch/output"
    printf 'userland candidate: separate initramfs/root received; package publication NOT claimed\n'
fi
