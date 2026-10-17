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
compiler=compiler/postlink-compiler/build/postlink-compiler
verify=compiler/optimized-x86/build/postlink-verify
receipt() { printf 'oracle-elf-begin %s %s\n' "$1" "$(sha256sum "$2" | cut -d ' ' -f 1)";zstd -q -c "$2" | base64;printf 'oracle-elf-end\n'; }
test -b /dev/vdd;test -b /dev/vde
. distribution/sources.env
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
cp "distribution/config/busybox-$BUSYBOX_VERSION.config" \
    "$scratch/source/busybox-$BUSYBOX_VERSION/.config"
KCONFIG_NOTIMESTAMP=1 make -C "$scratch/source/busybox-$BUSYBOX_VERSION" oldconfig </dev/null
cmp "distribution/config/busybox-$BUSYBOX_VERSION.config" \
    "$scratch/source/busybox-$BUSYBOX_VERSION/.config"
make -j4 -C "$scratch/source/busybox-$BUSYBOX_VERSION" busybox
busybox_input=$scratch/source/busybox-$BUSYBOX_VERSION/busybox_unstripped
cc -O2 -Wall -Wextra distribution/oracle/trace-userland.c -o "$scratch/trace"
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
# Exercise normal address parsing and bounded ping in both independently
# runnable ELFs. Device transport is not involved in this loopback witness.
for executable in "$busybox_input" "$scratch/busybox-optimized";do
    "$executable" ip link set lo up
    "$executable" ping -c 1 -W 4 127.0.0.1
    "$executable" getopt -o c: -- -c 1 >"$scratch/getopt.out"
    grep -q "1" "$scratch/getopt.out"
    # pipefail is a locked development-shell requirement, not inferred from
    # the existence of /bin/sh or from the pipeline's last command.
    set +e
    "$executable" sh -c 'set -o pipefail; (exit 7) | cat'
    pipeline_status=$?
    set -e
    test "$pipeline_status" = 7
    test "$("$executable" find "$scratch/input" -type f | wc -l)" = 1
    chmod 640 "$scratch/input/a"
    test "$("$executable" stat -c %a "$scratch/input/a")" = 640
    "$executable" sha256sum "$scratch/input/a" >"$scratch/sha-check"
    "$executable" sha256sum -c "$scratch/sha-check"
done
printf 'userland publication: original/optimized networking argument gates green\n'
if [ "$candidate_root" = 1 ];then
    # Isolated boot candidate only: package database/signatures are NOT
    # republished by this diagnostic. Preserve the immutable shipped inputs.
    unsquashfs -d "$scratch/candidate-root" /dev/vdf >/dev/null
    cat "$scratch/busybox-optimized" >"$scratch/candidate-root/bin/busybox"
    cat "$scratch/tar-optimized" >"$scratch/candidate-root/usr/bin/tar"
    if [ "$init_profile" = 1 ];then
        mkdir -p distribution/upstream "$scratch/init-output" "$scratch/init-forest"
        tar -xf /dev/vdi -C distribution/upstream
        # Reuse the authoritative recipe and package postlink transaction,
        # not another hand-written service build or opcode substitution.
        init_set=$(QM_INIT_BUILD_ROOT="$scratch/init-build" QM_OUTPUT_ROOT="$scratch/init-output" QM_JOBS=4 bash distribution/packaging/build-init.sh)
        test "$(head -n 1 "$init_set")" = package-root-set-v1
        tail -n +2 "$init_set" | while IFS="$(printf '\t')" read -r package root;do
            mkdir "$scratch/init-forest/$package"
            cp -al "$root/." "$scratch/init-forest/$package/"
        done
        make -j4 -C compiler all
        bash distribution/packaging/optimize-payload.sh "$scratch/init-forest" "$scratch/init-optimized" \
            compiler/build/artifact-executable-stage "$verify"
        # This is an explicitly new diagnostic root, not an apk install or
        # a merge of two package owners. Only base-services' old boot script
        # changes; every other overlapping coordinate must still compare.
        old_boot="$scratch/candidate-root/usr/libexec/system/boot"
        test -f "$old_boot" && test ! -L "$old_boot"
        case $(realpath "$old_boot") in "$scratch/candidate-root/usr/libexec/system/boot") ;; *)exit 2;;esac
        rm -f -- "$old_boot"
        old_ready="$scratch/candidate-root/usr/libexec/system/ready"
        test -f "$old_ready" && test ! -L "$old_ready"
        case $(realpath "$old_ready") in "$scratch/candidate-root/usr/libexec/system/ready") ;; *)exit 2;;esac
        rm -f -- "$old_ready"
        old_database="$scratch/candidate-root/etc/s6-rc/compiled/current"
        test -d "$old_database" && test ! -L "$old_database"
        case $(realpath "$old_database") in "$scratch/candidate-root/etc/s6-rc/compiled/current") ;; *)exit 2;;esac
        rm -rf -- "$old_database"
        for package in "$scratch/init-optimized"/*;do
            bash distribution/packaging/clone-tree.sh "$package" "$scratch/candidate-root"
        done
        printf 'userland candidate: locked init profile rebuilt through authoritative recipe/postlink\n'
    fi
    # The candidate uses the authoritative account inputs too. The native
    # package publication remains separate; never mutate its signed payload.
    install -m 0644 distribution/config/passwd "$scratch/candidate-root/etc/passwd"
    install -m 0644 distribution/config/group "$scratch/candidate-root/etc/group"
    install -m 0600 distribution/config/shadow "$scratch/candidate-root/etc/shadow"
    install -m 0600 distribution/config/gshadow "$scratch/candidate-root/etc/gshadow"
    roles='initramfs system.squashfs'
    if [ "${LENGTH3_KERNEL_INPUT_BYTES:-0}" != 0 ];then
        head -c "$LENGTH3_KERNEL_INPUT_BYTES" /dev/vdj >"$scratch/candidate.kernel"
        printf '%s  %s\n' "$LENGTH3_KERNEL_INPUT_SHA256" "$scratch/candidate.kernel" | sha256sum -c -
        cat "$scratch/candidate.kernel" >"$scratch/candidate-root/boot/kernel"
        roles="kernel $roles"
    fi
    if [ "$kernel" = 1 ];then
        # Reuse the official kernel recipe and Kbuild wrapper. No host/WSL
        # kernel or separately invented image enters this diagnostic.
        head -c "$LENGTH3_KERNEL_SOURCE_BYTES" /dev/vdj >"distribution/upstream/linux-$LINUX_VERSION.tar.xz"
        QM_LINKED_KERNEL_ROOT="$scratch/kernel-build" QM_JOBS=4 bash distribution/build-linked-kernel.sh config
        kernel_build=$(find "$scratch/kernel-build/output" -mindepth 1 -maxdepth 1 -type d)
        cp "$kernel_build/.config" "distribution/config/linux-$LINUX_VERSION.config"
        cp "$kernel_build/.config" "$scratch/candidate.linux.config"
        QM_LINKED_KERNEL_ROOT="$scratch/kernel-build" QM_JOBS=4 bash distribution/build-linked-kernel.sh bzImage
        kernel_build=$(find "$scratch/kernel-build/output" -mindepth 1 -maxdepth 1 -type d)
        test -f "$kernel_build/vmlinux.unstripped"
        "$compiler" "$kernel_build/vmlinux.unstripped" -o "$scratch/kernel-optimized.elf"
        "$verify" "$kernel_build/vmlinux.unstripped" "$scratch/kernel-optimized.elf"
        bash distribution/oracle/package-postlinked-kernel.sh "$scratch/kernel-optimized.elf" "$kernel_build" "$scratch/candidate.kernel"
        cat "$scratch/candidate.kernel" >"$scratch/candidate-root/boot/kernel"
        roles="kernel linux.config $roles"
    fi
    mkdir "$scratch/boot-root"
    (cd "$scratch/boot-root";cpio -id </dev/vdg)
    cp distribution/initramfs/init "$scratch/boot-root/init"
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
