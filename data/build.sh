#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$here/.." && pwd)

# The release recipe always enters through the checked-in bootstrap lock.  A
# caller may choose scratch/output coordinates, but cannot silently substitute
# a different host compiler or build-tool population through PATH.
. "$here/bootstrap/environment.sh"
# All canonical package metadata and the later Artifact traversal must observe
# root ownership directly, including from the static apk binary.  Mapping the
# current unprivileged uid/gid to namespace root avoids both payload copies and a
# separate fakeroot/LD_PRELOAD route.
if [[ $(id -u) != 0 && ${QM_RELEASE_USERNS:-0} != 1 ]]; then
  exec unshare --user --map-root-user \
    env QM_RELEASE_USERNS=1 QM_PACKAGE_USERNS=1 \
      bash "$here/build.sh" "$@"
fi
. "$here/sources.env"
. "$here/distribution/profile.env"

bootstrap_lock_digest=$(
  {
    sha256sum "$here/bootstrap/packages.sha256" | cut -d' ' -f1
    sha256sum "$here/bootstrap/installed.lock" | cut -d' ' -f1
  } | sha256sum | cut -d' ' -f1
)
sources_digest=$(sha256sum "$here/sources.env" | cut -d' ' -f1)
profile_digest=$(sha256sum "$here/distribution/profile.env" | cut -d' ' -f1)

upstream="$here/upstream"
# Keep authenticated inputs, component checkpoints and release outputs under
# the caller-selected build/output roots.  Kernel and BusyBox source/object
# trees are reconstructible high-file-count worksets, so expand them on the
# native Linux filesystem rather than multiplying Windows metadata I/O.
build=${QM_BUILD_ROOT:-${TMPDIR:-/tmp}/libqm-linux-build}
out=${QM_OUTPUT_ROOT:-${TMPDIR:-/tmp}/libqm-linux-output}
work=${QM_LINUX_WORK_ROOT:-${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}/libqm-linux-work/$DISTRIBUTION_PROFILE_ID}
distribution_build=$build/distribution
mkdir -p "$upstream" "$build" "$out" "$work" "$distribution_build"

postlink_compiler=${QM_POSTLINK_COMPILER:-$repo/src/v2/postlink-compiler/build/postlink-compiler}
postlink_verify=${QM_POSTLINK_VERIFY:-$repo/src/v2/optimized-x86/build/postlink-verify}
executable_stage=${QM_ARTIFACT_EXECUTABLE_STAGE:-$repo/src/v2/build/artifact-executable-stage}
artifact_audit=${QM_ARTIFACT_AUDIT:-$repo/src/v2/artifact/build/artifact-measure-root}
if [[ ! -x $postlink_compiler || ! -x $postlink_verify \
    || ! -x $executable_stage || ! -x $artifact_audit ]]; then
  printf '%s\n' \
    'the boot distribution requires the C post-link compiler, verifier, and exact Artifact population audit' \
    "compiler: $postlink_compiler" "stage: $executable_stage" \
    "verifier: $postlink_verify" \
    "artifact-audit: $artifact_audit" >&2
  exit 2
fi
postlink_compiler_tools_digest=$(
  {
    sha256sum "$postlink_compiler" | cut -d' ' -f1
    sha256sum "$postlink_verify" | cut -d' ' -f1
  } | sha256sum | cut -d' ' -f1
)
release_publication_tools_digest=$(
  {
    sha256sum "$postlink_compiler" | cut -d' ' -f1
    sha256sum "$executable_stage" | cut -d' ' -f1
    sha256sum "$postlink_verify" | cut -d' ' -f1
    sha256sum "$here/distribution/optimize-payload.sh" | cut -d' ' -f1
    sha256sum "$here/distribution/emit-package-set.sh" | cut -d' ' -f1
    sha256sum "$here/distribution/assemble-package-set.sh" | cut -d' ' -f1
  } | sha256sum | cut -d' ' -f1
)
artifact_audit_digest=$(sha256sum "$artifact_audit" | cut -d' ' -f1)

# PID 1, service-state and device-event binaries are part of the standard
# release closure, not an optional overlay. Component builders return ordinary
# relocation-bearing linked roots; only the complete release owns post-link
# compilation, so equivalent blocks may share across component boundaries.
init_package_set=$(QM_OUTPUT_ROOT="$out" \
  QM_INIT_BUILD_ROOT="$distribution_build/init" \
  "$here/distribution/build-init.sh")
if [[ ! -f $init_package_set ]]; then
  printf 'verified init/service package set was not produced: %s\n' \
    "$init_package_set" >&2
  exit 1
fi
init_identity=$(basename -- "$init_package_set" .packages)
init_root=$distribution_build/init-sysroot/$init_identity/root
bash "$here/distribution/assemble-package-set.sh" \
  "$init_package_set" "$init_root" >/dev/null

# Kernel/mount administration and network inspection are real package
# providers, not aliases that happen to exist in the rescue BusyBox image.
# Their linked x86 programs join the same release-wide publication boundary as
# every other standard-profile executable.
core_tools_package_set=$(QM_OUTPUT_ROOT="$out" \
  QM_CORE_BUILD_ROOT="$distribution_build/core-tools" \
  "$here/distribution/build-core-tools.sh")
if [[ ! -f $core_tools_package_set ]]; then
  printf 'verified core-tools package set was not produced: %s\n' \
    "$core_tools_package_set" >&2
  exit 1
fi
core_tools_identity=$(basename -- "$core_tools_package_set" .packages)
core_tools_root=$distribution_build/core-tools-sysroot/$core_tools_identity/root
bash "$here/distribution/assemble-package-set.sh" \
  "$core_tools_package_set" "$core_tools_root" >/dev/null

if [[ -z ${QM_TOOLCHAIN_PACKAGE_SET:-} ]] || \
   [[ ! -f $QM_TOOLCHAIN_PACKAGE_SET ]]; then
  printf 'QM_TOOLCHAIN_PACKAGE_SET must name the verified toolchain package set\n' >&2
  exit 1
fi
toolchain_digest=$(basename -- "$QM_TOOLCHAIN_PACKAGE_SET" .packages)
toolchain_root=$distribution_build/toolchain/$toolchain_digest/root
bash "$here/distribution/assemble-package-set.sh" \
  "$QM_TOOLCHAIN_PACKAGE_SET" "$toolchain_root" >/dev/null

# Package management, network configuration, time, filesystem maintenance,
# accounts, capabilities, ACL/xattr, the editor and timezone database are part
# of the standard release rather than an optional rescue layer.  Build their
# exact providers against the verified linked-toolchain checkpoint. No
# component is permitted to erase relocation evidence before release closure.
system_tools_package_set=$(QM_OUTPUT_ROOT="$out" \
  QM_SYSTEM_BUILD_ROOT="$distribution_build/system-tools" \
  QM_TOOLCHAIN_PACKAGE_SET="$QM_TOOLCHAIN_PACKAGE_SET" \
  QM_TOOLCHAIN_ROOT="$toolchain_root" \
  "$here/distribution/build-system-tools.sh")
if [[ ! -f $system_tools_package_set ]]; then
  printf 'verified system-tools package set was not produced: %s\n' \
    "$system_tools_package_set" >&2
  exit 1
fi
system_tools_identity=$(basename -- "$system_tools_package_set" .packages)
system_tools_root=$distribution_build/system-tools-sysroot/$system_tools_identity/root
bash "$here/distribution/assemble-package-set.sh" \
  "$system_tools_package_set" "$system_tools_root" >/dev/null

fetch() {
  local url=$1 output=$2 expected=$3
  if [[ ! -f "$output" ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$output.part" "$url"
    mv "$output.part" "$output"
  fi
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status
}

extract_source_once() {
  local archive=$1 directory=$2
  local name stage extracted
  name=$(basename -- "$directory")
  stage=$work/.extract-$name
  extracted=$stage/$name
  if [[ -f $directory/.qm-source-complete ]]; then
    return
  fi
  if [[ -e $directory || -e $stage ]]; then
    printf 'incomplete source checkpoint exists: %s\n' "$directory" >&2
    return 1
  fi
  mkdir -p "$stage"
  tar -C "$stage" --no-same-owner -xf "$archive"
  if [[ ! -d $extracted ]]; then
    printf 'source archive did not produce %s\n' "$name" >&2
    return 1
  fi
  printf 'source-checkpoint-v1\narchive=%s\n' "$(basename -- "$archive")" \
    > "$extracted/.qm-source-complete"
  mv "$extracted" "$directory"
  rmdir "$stage"
}

apply_config_fragment() {
  local config=$1 fragment=$2 line key value
  while IFS= read -r line; do
    case $line in
      CONFIG_*=*)
        key=${line%%=*}
        value=${line#*=}
        case $key in
          CONFIG_[A-Z0-9_]*) ;;
          *)
            printf 'invalid Kconfig fragment assignment: %s\n' "$line" >&2
            return 1
            ;;
        esac
        sed -i -e "/^${key}=/d" -e "/^# ${key} is not set$/d" "$config"
        if [[ $value == n ]]; then
          printf '# %s is not set\n' "$key" >> "$config"
        else
          printf '%s=%s\n' "$key" "$value" >> "$config"
        fi
        ;;
    esac
  done < "$fragment"
}

resolve_busybox_cc() {
  bootstrap_cc "${QM_BUSYBOX_CC:-}"
}

ensure_libelf_pkg_config() {
  pkg-config --exists libelf
}

verify_config_lock() {
  local generated=$1 locked=$2
  if [[ ! -f $locked ]]; then
    printf 'missing resolved config lock: %s\n' "$locked" >&2
    return 1
  fi
  if ! cmp -s "$generated" "$locked"; then
    printf 'resolved config differs from lock: %s\n' "$locked" >&2
    diff -u "$locked" "$generated" || true
    return 1
  fi
}

linux_tar="$upstream/linux-$LINUX_VERSION.tar.xz"
busybox_tar="$upstream/busybox-$BUSYBOX_VERSION.tar.bz2"
fetch "$LINUX_URL" "$linux_tar" "$LINUX_SHA256"
fetch "$BUSYBOX_URL" "$busybox_tar" "$BUSYBOX_SHA256"

linux_src="$work/linux-$LINUX_VERSION"
busybox_src="$work/busybox-$BUSYBOX_VERSION"
extract_source_once "$linux_tar" "$linux_src"
extract_source_once "$busybox_tar" "$busybox_src"
busybox_o="$busybox_src"
busybox_cc=$(resolve_busybox_cc)
busybox_stamp="$busybox_src/.qm-build"
busybox_key=$(
  {
    sha256sum "$here/config/busybox.fragment"
    "$busybox_cc" --version | sed -n '1p'
    printf '%s\n' "$QM_BOOTSTRAP_ID"
    printf '%s\n' 'linked-busybox-postlink-v2'
  } | sha256sum | cut -d' ' -f1
)
busybox_root="$distribution_build/busybox-input-$busybox_key/root"
if [[ ! -x $busybox_root/bin/busybox ]] || \
   [[ ! -f $busybox_stamp ]] || \
   [[ $(<"$busybox_stamp") != "$busybox_key" ]]; then
  make -C "$busybox_src" distclean
  KCONFIG_NOTIMESTAMP=1 make -C "$busybox_src" allnoconfig
  apply_config_fragment "$busybox_src/.config" "$here/config/busybox.fragment"
  KCONFIG_NOTIMESTAMP=1 make -C "$busybox_src" oldconfig </dev/null
  make -C "$busybox_src" CC="$busybox_cc" -j"$(nproc)"
  make -C "$busybox_src" CC="$busybox_cc" \
    CONFIG_PREFIX="$busybox_root" install
  # BusyBox's install target selects its pre-stripped convenience image.
  # Package publication must instead begin at the ordinary linker result so
  # the C post-link compiler is the sole transformation and proof boundary.
  install -m 0755 "$busybox_src/busybox_unstripped" \
    "$busybox_root/bin/busybox"
  printf '%s\n' "$busybox_key" > "$busybox_stamp"
fi
verify_config_lock "$busybox_src/.config" \
  "$here/config/busybox-$BUSYBOX_VERSION.config"
install -D -m 0755 "$here/initramfs/init" "$busybox_root/init"
install -d -m 0755 "$busybox_root/dev" "$busybox_root/proc" \
  "$busybox_root/sys" "$busybox_root/system" "$busybox_root/usr" \
  "$busybox_root/etc" "$busybox_root/etc/ssl"
install -d -m 1777 "$busybox_root/tmp"

install -D -m 0644 "$here/bootstrap/Makefile" \
  "$busybox_root/opt/qm/Makefile"

boot_root=$busybox_root
"$boot_root/bin/busybox" true

linux_o="$work/linux-out/$QM_BOOTSTRAP_ID"
mkdir -p "$linux_o"
ensure_libelf_pkg_config
make -C "$linux_src" O="$linux_o" ARCH=x86_64 allnoconfig
while IFS= read -r option; do
  key=${option%%=*}
  symbol=${key#CONFIG_}
  case $option in
    CONFIG_*=y)
      "$linux_src/scripts/config" --file "$linux_o/.config" \
        --enable "$symbol" ;;
    CONFIG_*=n)
      "$linux_src/scripts/config" --file "$linux_o/.config" \
        --disable "$symbol" ;;
  esac
done < "$here/config/linux.fragment"
make -C "$linux_src" O="$linux_o" ARCH=x86_64 olddefconfig
verify_config_lock "$linux_o/.config" \
  "$here/config/linux-$LINUX_VERSION.config"
make -C "$linux_src" O="$linux_o" ARCH=x86_64 -j"$(nproc)" \
  CONFIG_ARCH_VMLINUX_NEEDS_RELOCS=y bzImage

# The distribution never publishes Kbuild's unoptimized linked payload.  The
# ordinary relocation-bearing x86 ELF is the sole compiler input; its proved
# optimized x86 ELF is independently verifiable and is then wrapped by the
# unchanged x86 boot protocol.  The checkpoint key binds both linked bytes and
# the exact compiler/verifier pair, so a tool update redoes only this projection
# and downstream release assembly rather than rebuilding upstream packages.
linked_kernel="$linux_o/vmlinux.unstripped"
if [[ ! -f $linked_kernel ]]; then
  printf 'Kbuild did not retain the relocation-bearing linked kernel: %s\n' \
    "$linked_kernel" >&2
  exit 1
fi
# Under pipefail, `grep -q` can close the pipe after its first match and turn
# readelf's resulting SIGPIPE into a false negative.  Consume the complete
# section table; this gate is about the linked input, not producer timing.
if ! readelf -SW "$linked_kernel" | grep '[.]rela[.]' >/dev/null; then
  printf 'linked kernel lacks static construction relocations: %s\n' \
    "$linked_kernel" >&2
  exit 1
fi
linked_kernel_digest=$(sha256sum "$linked_kernel" | cut -d' ' -f1)
postlinked_kernel_key=$(printf '%s\n' \
  "$linked_kernel_digest" "$postlink_compiler_tools_digest" \
  'postlinked-linux-bzimage-v1' | sha256sum | cut -d' ' -f1)
postlinked_kernel="$build/postlinked-kernel-$postlinked_kernel_key"
optimized_kernel="$postlinked_kernel/vmlinux"
kernel_image="$postlinked_kernel/bzImage"
mkdir -p "$postlinked_kernel"
if [[ ! -f $postlinked_kernel/.complete ]]; then
  "$postlink_compiler" "$linked_kernel" \
    -o "$postlinked_kernel/vmlinux.tmp"
  "$postlink_verify" "$linked_kernel" \
    "$postlinked_kernel/vmlinux.tmp"
  mv "$postlinked_kernel/vmlinux.tmp" "$optimized_kernel"
  bash "$here/oracle/package-postlinked-kernel.sh" \
    "$optimized_kernel" "$linux_o" "$postlinked_kernel/bzImage.tmp"
  mv "$postlinked_kernel/bzImage.tmp" "$kernel_image"
  {
    printf 'format=postlinked-linux-bzimage-v1\n'
    printf 'linked.sha256=%s\n' "$linked_kernel_digest"
    printf 'optimized.sha256=%s\n' \
      "$(sha256sum "$optimized_kernel" | cut -d' ' -f1)"
    printf 'bzimage.sha256=%s\n' \
      "$(sha256sum "$kernel_image" | cut -d' ' -f1)"
    printf 'postlink.tools.sha256=%s\n' \
      "$postlink_compiler_tools_digest"
  } > "$postlinked_kernel/inputs.tmp"
  mv "$postlinked_kernel/inputs.tmp" "$postlinked_kernel/inputs"
  touch "$postlinked_kernel/.complete"
fi
"$postlink_verify" "$linked_kernel" "$optimized_kernel"
optimized_kernel_digest=$(sha256sum "$optimized_kernel" | cut -d' ' -f1)
kernel_image_digest=$(sha256sum "$kernel_image" | cut -d' ' -f1)

declare -A linked_package_root=()
add_package_set() {
  local manifest=$1 rows package package_root extra
  if [[ $(head -n 1 -- "$manifest") != package-root-set-v1 ]]; then
    printf 'unknown package-set schema: %s\n' "$manifest" >&2
    exit 1
  fi
  rows=$(mktemp)
  tail -n +2 -- "$manifest" >"$rows"
  if [[ ! -s $rows ]] || ! sort -t $'\t' -k1,1 -c -u "$rows"; then
    printf 'package-set rows are not canonical: %s\n' "$manifest" >&2
    rm -f -- "$rows"
    exit 1
  fi
  while IFS=$'\t' read -r package package_root extra; do
    if [[ -n $extra || ! -d $package_root || \
          -n ${linked_package_root[$package]+present} ]]; then
      printf 'invalid or duplicate release package: %s\n' "$package" >&2
      rm -f -- "$rows"
      exit 1
    fi
    linked_package_root[$package]=$package_root
  done <"$rows"
  rm -f -- "$rows"
}

add_package_set "$QM_TOOLCHAIN_PACKAGE_SET"
add_package_set "$init_package_set"
add_package_set "$core_tools_package_set"
add_package_set "$system_tools_package_set"
if [[ -n ${linked_package_root[busybox]+present} ]]; then
  printf 'release package name is duplicated: busybox\n' >&2
  exit 1
fi
linked_package_root[busybox]=$busybox_root

# Release policy is not a toolchain payload.  A verified toolchain checkpoint
# may have been built under an older packaging profile while its linked x86 is
# still byte-for-byte reusable. Form the final metadata owner from the current
# release inputs here so changing package policy never requires rebuilding GCC
# or lets stale policy bytes leak into the signed root.
toolchain_target=$($toolchain_root/usr/bin/gcc -dumpmachine)
case $toolchain_target in
  x86_64-*-linux-musl) ;;
  *)
    printf 'toolchain checkpoint has an unexpected target: %s\n' \
      "$toolchain_target" >&2
    exit 1
    ;;
esac
release_metadata_digest=$(
  {
    sha256sum "$here/sources.env"
    sha256sum "$here/distribution/profile.env"
    sha256sum "$here/distribution/runtime-closure.tsv.in"
    sha256sum "$here/bootstrap/packages.sha256"
    sha256sum "$here/bootstrap/installed.lock"
    printf 'target=%s\n' "$toolchain_target"
    printf 'gcc=%s\n' "$GCC_VERSION"
    printf 'release-metadata-owner-v1\n'
  } | sha256sum | cut -d' ' -f1
)
release_metadata_prefix="$distribution_build/release-metadata-$release_metadata_digest"
release_metadata_root="$release_metadata_prefix/root"
if [[ ! -f $release_metadata_prefix/.complete ]]; then
  if [[ -e $release_metadata_prefix ]]; then
    printf 'incomplete release metadata checkpoint exists: %s\n' \
      "$release_metadata_prefix" >&2
    exit 1
  fi
  mkdir -p "$release_metadata_root/usr/share/qm"
  install -m 0644 "$here/sources.env" \
    "$release_metadata_root/usr/share/qm/sources.env"
  install -m 0644 "$here/distribution/profile.env" \
    "$release_metadata_root/usr/share/qm/distribution-profile.env"
  install -m 0644 "$here/bootstrap/packages.sha256" \
    "$release_metadata_root/usr/share/qm/bootstrap-packages.sha256"
  install -m 0644 "$here/bootstrap/installed.lock" \
    "$release_metadata_root/usr/share/qm/bootstrap-installed.lock"
  sed -e "s|@TARGET@|$toolchain_target|g" \
      -e "s|@GCC_VERSION@|$GCC_VERSION|g" \
      "$here/distribution/runtime-closure.tsv.in" \
      >"$release_metadata_root/usr/share/qm/runtime-closure.tsv"
  if ! tail -n +2 \
       "$release_metadata_root/usr/share/qm/runtime-closure.tsv" | \
       LC_ALL=C sort -c -u; then
    printf 'generated release runtime closure is not canonical\n' >&2
    exit 1
  fi
  touch "$release_metadata_prefix/.complete"
fi
linked_package_root[release-metadata]=$release_metadata_root

# Package ownership survives the transformation.  The compiler is scheduled
# over every package root, but each ordinary optimized ELF is returned to the
# same package/path coordinate as its linked input.  Only after this map is
# complete may an analysis root or an apk transaction be formed.
release_key=$(printf '%s\n' "$LINUX_SHA256" "$BUSYBOX_SHA256" \
  "$linked_kernel_digest" "$optimized_kernel_digest" \
  "$kernel_image_digest" \
  "$toolchain_digest" "$init_identity" "$core_tools_identity" \
  "$system_tools_identity" \
  "$release_publication_tools_digest" "$sources_digest" "$profile_digest" \
  "$bootstrap_lock_digest" "$release_metadata_digest" \
  'canonical-release-package-roots-v8' | \
  sha256sum | cut -d' ' -f1)
release_prefix="$build/release-$release_key"
optimized_package_root="$release_prefix/packages.optimized"
postlink_report_root="$release_prefix/postlink-reports"
postlink_release_report="$postlink_report_root/release.report"
optimized_package_set="$release_prefix/optimized-$release_key.packages"
postlink_complete="$release_prefix/.postlink-complete"
if [[ ! -f $postlink_complete ]]; then
  if [[ -e $optimized_package_set || -e $optimized_package_root \
      || -e $postlink_report_root ]]; then
    printf 'release-wide post-link checkpoint is incomplete: %s\n' \
      "$release_prefix" >&2
    exit 1
  fi
  mkdir -p "$release_prefix" "$postlink_report_root"
  package_names=$(printf '%s\n' "${!linked_package_root[@]}" | sort)
  linked_package_forest="$release_prefix/.packages.linked.$$"
  mkdir -p "$linked_package_forest"
  forest_device=$(stat -c %d -- "$linked_package_forest")
  cleanup_linked_package_forest() {
    rm -rf -- "$linked_package_forest"
  }
  trap cleanup_linked_package_forest EXIT HUP INT TERM
  while IFS= read -r package; do
    [[ -n $package ]] || continue
    package_source=${linked_package_root[$package]}
    if [[ $(stat -c %d -- "$package_source") != "$forest_device" ]]; then
      printf 'release-wide post-link forest crosses filesystems: %s\n' \
        "$package_source" >&2
      exit 1
    fi
    mkdir -p "$linked_package_forest/$package"
    # This forest is a transient namespace only. Regular payload bytes remain
    # owned by their package roots; hard links expose the disjoint union to one
    # compiler transaction without another N-byte materialization.
    cp -al -- "$package_source/." "$linked_package_forest/$package/"
  done <<<"$package_names"
  POSTLINK_PAYLOAD_REPORT="$postlink_release_report" \
    "$here/distribution/optimize-payload.sh" \
      "$linked_package_forest" "$optimized_package_root" \
      "$executable_stage" "$postlink_verify"
  if [[ ! -d $optimized_package_root || ! -s $postlink_release_report ]] || \
     ! grep -qxF 'format=optimized-payload-report-v12' \
       "$postlink_release_report" || \
     ! grep -qxF 'stage_processes=1' "$postlink_release_report"; then
    printf 'release-wide post-link checkpoint did not commit\n' >&2
    exit 1
  fi
  cleanup_linked_package_forest
  trap - EXIT HUP INT TERM

  # The boot archive is a deterministic projection of the already optimized
  # BusyBox package. Its members therefore contain the same optimized bytes,
  # while Artifact identity later shares the duplicate immutable extents.
  boot_package="$optimized_package_root/linux-boot"
  mkdir -p "$boot_package/boot"
  install -m 0644 "$kernel_image" "$boot_package/boot/kernel"
  boot_list="$release_prefix/boot-paths.tmp"
  (
    cd "$optimized_package_root/busybox"
    find . -print0 | LC_ALL=C sort -z > "$boot_list"
  )
  (
    cd "$optimized_package_root/busybox"
    cpio --null -o --format=newc --owner=0:0 --reproducible \
      < "$boot_list" > "$boot_package/boot/initramfs.tmp"
  )
  mv "$boot_package/boot/initramfs.tmp" "$boot_package/boot/initramfs"
  rm -f -- "$boot_list"

  package_outputs=("linux-boot:$boot_package")
  while IFS= read -r package; do
    [[ -n $package ]] || continue
    package_outputs+=("$package:$optimized_package_root/$package")
  done <<<"$package_names"
  generated_package_set=$(bash "$here/distribution/emit-package-set.sh" \
    "$release_prefix" optimized "$release_key" \
    "${package_outputs[@]}")
  if [[ $generated_package_set != "$optimized_package_set" ]]; then
    printf 'optimized package-set coordinate drifted: %s\n' \
      "$generated_package_set" >&2
    exit 1
  fi

  # Do not form a raw union here.  It was never consumed: the only product
  # root is the candidate installed from the signed apk repository below.
  # Artifact observes that installed root, so merging package payloads here
  # only duplicates namespace work and can exhaust filesystem link counts.
  touch "$postlink_complete"
fi

# The analysis union above is never a release.  Product state begins with a
# signed apk repository and is formed only by apk's offline transaction.  Keep
# package signing outside the expensive post-link checkpoint so a key rotation
# republishes packages without recompiling linked x86.
bash "$here/distribution/check-package-recipes.sh" \
  "$optimized_package_set" >/dev/null
if [[ -z ${QM_APK_SIGNING_KEY:-} || -z ${QM_APK_PUBLIC_KEY:-} ]]; then
  printf '%s\n' \
    'signed apk publication: red' \
    'QM_APK_SIGNING_KEY and QM_APK_PUBLIC_KEY are required' \
    "optimized-package-set=$optimized_package_set" >&2
  exit 3
fi
package_public_key=$(realpath -e -- "$QM_APK_PUBLIC_KEY")
package_public_key_digest=$(sha256sum "$package_public_key" | cut -d' ' -f1)
package_publication_tools_digest=$(
  {
    sha256sum "$here/distribution/package-recipes.sh"
    sha256sum "$here/distribution/publish-apk.sh"
    sha256sum "$here/distribution/check-package-recipes.sh"
    sha256sum "$here/distribution/check-package-publication.sh"
    sha256sum "$here/distribution/check-package-state.sh"
  } | sha256sum | cut -d' ' -f1
)
package_publication_key=$(printf '%s\n' \
  "$release_key" "$package_public_key_digest" \
  "$package_publication_tools_digest" "$release_metadata_digest" \
  'signed-apk-publication-v2' | \
  sha256sum | cut -d' ' -f1)
apk_publication="$release_prefix/apk-$package_publication_key"
release_root="$apk_publication/root"
if [[ ! -d $release_root ]]; then
  if [[ -e $apk_publication ]]; then
    printf 'incomplete signed apk publication exists: %s\n' \
      "$apk_publication" >&2
    exit 1
  fi
  QM_APK_SIGNING_KEY="$QM_APK_SIGNING_KEY" \
    QM_APK_PUBLIC_KEY="$package_public_key" \
    QM_ALLOW_TEST_SIGNING_KEY="${QM_ALLOW_TEST_SIGNING_KEY:-0}" \
    bash "$here/distribution/publish-apk.sh" \
      "$optimized_package_set" "$apk_publication" >/dev/null
fi
bash "$here/distribution/check-package-publication.sh" "$apk_publication"

initramfs=$release_root/boot/initramfs

# A tar or filesystem image cannot prove release completion. Every declared
# command, dynamic dependency, runtime-discovered resource, service input and
# proof-bearing ELF must resolve in this one candidate root.
"$here/distribution/check-root.sh" "$release_root" "$postlink_verify"

release_population="$out/release-$package_publication_key.population"
bash "$here/distribution/measure-root.sh" \
  "$release_root" "$release_population"
release_page_population="$out/release-$package_publication_key.exact-pages.population"
"$artifact_audit" "$release_root" "$release_page_population"
grep -qxF 'format=artifact-immutable-page-population-v4' \
  "$release_page_population"
grep -qxF 'identity=extent-and-exact-bytes' "$release_page_population"
grep -qxF 'digest_role=candidate-index-only' "$release_page_population"
grep -qxF 'archive.identity=canonical-gnu-ar-view-v1' \
  "$release_page_population"
archive_members=$(sed -n \
  's/^archive.member_occurrences=//p' "$release_page_population")
archive_payload_bytes=$(sed -n \
  's/^archive.member_payload_bytes=//p' "$release_page_population")
archive_unique_payload_bytes=$(sed -n \
  's/^archive.unique_member_payload_bytes=//p' "$release_page_population")
archive_duplicate_payload_bytes=$(sed -n \
  's/^archive.duplicate_member_payload_bytes=//p' "$release_page_population")
archive_generated_bytes=$(sed -n \
  's/^archive.generated_stream_bytes=//p' "$release_page_population")
archive_input_bytes=$(sed -n \
  's/^archive.input_stream_bytes=//p' "$release_page_population")
archive_rewritten_streams=$(sed -n \
  's/^archive.rewritten_streams=//p' "$release_page_population")
if [[ ! $archive_members =~ ^[1-9][0-9]*$ \
    || ! $archive_payload_bytes =~ ^[1-9][0-9]*$ \
    || ! $archive_unique_payload_bytes =~ ^[1-9][0-9]*$ \
    || ! $archive_duplicate_payload_bytes =~ ^[0-9]+$ \
    || ! $archive_generated_bytes =~ ^[1-9][0-9]*$ \
    || ! $archive_input_bytes =~ ^[1-9][0-9]*$ \
    || $archive_rewritten_streams != 0 \
    || $archive_generated_bytes != "$archive_input_bytes" \
    || $archive_payload_bytes -ge $archive_generated_bytes \
    || $((archive_unique_payload_bytes + archive_duplicate_payload_bytes)) \
       -ne $archive_payload_bytes ]]; then
  printf 'release archive population is not a complete generated view\n' >&2
  exit 1
fi
release_filesystem_bytes=$(sed -n \
  's/^canonical_filesystem_bytes=//p' "$release_population")
if [[ ! $release_filesystem_bytes =~ ^[0-9]+$ ]]; then
  printf 'release population omitted canonical filesystem bytes\n' >&2
  exit 1
fi

release_inputs="$out/release-$package_publication_key.inputs"
{
  printf 'format=canonical-release-inputs-v4\n'
  printf 'profile=%s\n' "$DISTRIBUTION_PROFILE_ID"
  printf 'artifact.semantic-family-mask=%s\n' \
    "$DISTRIBUTION_ARTIFACT_SEMANTIC_FAMILY_MASK"
  printf 'kernel.linked.sha256=%s\n' "$linked_kernel_digest"
  printf 'kernel.optimized-elf.sha256=%s\n' "$optimized_kernel_digest"
  printf 'kernel.bzimage.sha256=%s\n' "$kernel_image_digest"
  printf 'initramfs.sha256=%s\n' "$(sha256sum "$initramfs" | cut -d' ' -f1)"
  printf 'toolchain.package-set.identity=%s\n' "$toolchain_digest"
  printf 'init.package-set.identity=%s\n' "$init_identity"
  printf 'core-tools.package-set.identity=%s\n' "$core_tools_identity"
  printf 'system-tools.package-set.identity=%s\n' "$system_tools_identity"
  printf 'optimized.package-set.identity=%s\n' "$release_key"
  printf 'optimized.package-count=%s\n' \
    "$(tail -n +2 "$optimized_package_set" | wc -l)"
  printf 'package.publication.identity=%s\n' "$package_publication_key"
  printf 'package.public-key.sha256=%s\n' "$package_public_key_digest"
  printf 'package.index.sha256=%s\n' \
    "$(sha256sum "$apk_publication/repository/Packages.adb" | cut -d' ' -f1)"
  printf 'package.count=%s\n' \
    "$(find "$apk_publication/repository" -maxdepth 1 -type f -name '*.apk' | wc -l)"
  printf 'sources.sha256=%s\n' "$sources_digest"
  printf 'profile.sha256=%s\n' "$profile_digest"
  printf 'postlink.compiler-tools.sha256=%s\n' \
    "$postlink_compiler_tools_digest"
  printf 'release.publication-tools.sha256=%s\n' \
    "$release_publication_tools_digest"
  printf 'package.publication-tools.sha256=%s\n' \
    "$package_publication_tools_digest"
  printf 'release.metadata.sha256=%s\n' "$release_metadata_digest"
  printf 'artifact.audit.sha256=%s\n' "$artifact_audit_digest"
  printf 'bootstrap.lock.sha256=%s\n' "$bootstrap_lock_digest"
} > "$release_inputs.tmp"
mv "$release_inputs.tmp" "$release_inputs"

printf '%s\n' \
  'signed apk publication: green' \
  "root=$release_root" \
  "repository=$apk_publication/repository/Packages.adb" \
  "population=$release_population" \
  "exact-page-upper-bound=$release_page_population" \
  "canonical-filesystem-bytes=$release_filesystem_bytes" \
  "artifact-target-bytes=$DISTRIBUTION_RELEASE_MAX_BYTES" \
  "kernel=$kernel_image" \
  "initramfs=$initramfs" \
  "inputs=$release_inputs"

printf '%s\n' \
  'canonical artifact publication: not connected'
exit 3
