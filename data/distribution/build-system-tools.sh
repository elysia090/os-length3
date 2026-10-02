#!/usr/bin/env bash
set -euo pipefail

# Component builders expose one machine-readable result coordinate on stdout.
# All upstream build chatter stays diagnostic, including on a cold build.
exec 3>&1
exec 1>&2

here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
repo=$(cd -- "$data/.." && pwd)

. "$data/bootstrap/environment.sh"
. "$data/sources.env"
. "$here/profile.env"

upstream=$data/upstream
# Source expansion and compiler objects are reconstructible and contain many
# small files, so keep them on the Linux filesystem.  Completed package roots
# and publications are durable Windows-side checkpoints.
build=${QM_SYSTEM_BUILD_ROOT:-$repo/temp/system-tools-build}
work=${QM_SYSTEM_WORK_ROOT:-${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}/libqm-system-tools-work}
source_root=$work/sources
object_root=$work/objects
out=${QM_OUTPUT_ROOT:-$repo/temp/system-tools-output}
jobs=${QM_JOBS:-$(nproc)}
mkdir -p "$upstream" "$build/packages" "$build/publications" \
  "$source_root" "$object_root" "$out"
if [[ -z ${QM_TOOLCHAIN_PACKAGE_SET:-} || \
      ! -f $QM_TOOLCHAIN_PACKAGE_SET ]]; then
  printf 'QM_TOOLCHAIN_PACKAGE_SET must name the verified toolchain package set\n' >&2
  exit 2
fi

fetch() {
  local url=$1 target=$2 expected=$3
  if [[ ! -f $target ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$target.part" "$url"
    mv "$target.part" "$target"
  fi
  printf '%s  %s\n' "$expected" "$target" | sha256sum --check --status
}

extract_once() {
  local archive=$1 directory=$2 marker=$2/.qm-source-complete
  if [[ -f $marker ]]; then
    return
  fi
  if [[ -e $directory ]]; then
    printf 'incomplete source checkpoint exists: %s\n' "$directory" >&2
    return 1
  fi
  tar -C "$source_root" --no-same-owner -xf "$archive"
  touch "$marker"
}

extract_tzdata_once() {
  local archive=$1 directory=$2 marker=$2/.qm-source-complete
  if [[ -f $marker ]]; then
    return
  fi
  if [[ -e $directory ]]; then
    printf 'incomplete tzdata source checkpoint exists: %s\n' \
      "$directory" >&2
    return 1
  fi
  mkdir -p "$directory"
  tar -C "$directory" --no-same-owner -xf "$archive"
  touch "$marker"
}

resolve_cc() {
  bootstrap_cc "${QM_SYSTEM_CC:-}"
}

resolve_build_tool() {
  command -v "$1"
}

cc=$(resolve_cc)
target=$($cc -dumpmachine)
case $target in
  x86_64-*-linux-musl) ;;
  *)
    printf 'system-tools compiler must target x86_64 Linux musl, got %s\n' \
      "$target" >&2
    exit 1
    ;;
esac
ar=$(command -v ar)
ranlib=$(command -v ranlib)
pkgconf=$(resolve_build_tool pkgconf)
meson=$(resolve_build_tool meson)
ninja=$(resolve_build_tool ninja)

toolchain_digest=$(sha256sum "$QM_TOOLCHAIN_PACKAGE_SET" | cut -d' ' -f1)
if [[ -n ${QM_TOOLCHAIN_ROOT:-} ]]; then
  toolchain_root=$QM_TOOLCHAIN_ROOT
  if [[ ! -d $toolchain_root ]]; then
    printf 'verified toolchain root does not exist: %s\n' \
      "$toolchain_root" >&2
    exit 1
  fi
  if [[ ! -f $toolchain_root.package-set || \
        $(<"$toolchain_root.package-set") != "$toolchain_digest" ]]; then
    printf 'provided toolchain sysroot does not match its package set: %s\n' \
      "$toolchain_root" >&2
    exit 2
  fi
else
  # Package roots are durable Windows-side checkpoints.  Assemble the
  # build-only sysroot beside them so clone-tree can preserve hard-link
  # identity without copying the entire toolchain across filesystems.
  toolchain_root=$build/toolchain/$toolchain_digest/root
  bash "$here/assemble-package-set.sh" \
    "$QM_TOOLCHAIN_PACKAGE_SET" "$toolchain_root" >/dev/null
fi

archives=(
  "apk-tools-v$APK_TOOLS_VERSION.tar.gz|$APK_TOOLS_URL|$APK_TOOLS_SHA256"
  "dhcpcd-$DHCPCD_VERSION.tar.xz|$DHCPCD_URL|$DHCPCD_SHA256"
  "libmnl-$LIBMNL_VERSION.tar.bz2|$LIBMNL_URL|$LIBMNL_SHA256"
  "libnftnl-$LIBNFTNL_VERSION.tar.xz|$LIBNFTNL_URL|$LIBNFTNL_SHA256"
  "nftables-$NFTABLES_VERSION.tar.xz|$NFTABLES_URL|$NFTABLES_SHA256"
  "chrony-$CHRONY_VERSION.tar.gz|$CHRONY_URL|$CHRONY_SHA256"
  "e2fsprogs-$E2FSPROGS_VERSION.tar.xz|$E2FSPROGS_URL|$E2FSPROGS_SHA256"
  "shadow-$SHADOW_VERSION.tar.xz|$SHADOW_URL|$SHADOW_SHA256"
  "libcap-$LIBCAP_VERSION.tar.xz|$LIBCAP_URL|$LIBCAP_SHA256"
  "acl-$ACL_VERSION.tar.xz|$ACL_URL|$ACL_SHA256"
  "attr-$ATTR_VERSION.tar.xz|$ATTR_URL|$ATTR_SHA256"
  "zstd-$ZSTD_VERSION.tar.gz|$ZSTD_URL|$ZSTD_SHA256"
  "ncurses-$NCURSES_VERSION.tar.gz|$NCURSES_URL|$NCURSES_SHA256"
  "nano-$NANO_VERSION.tar.xz|$NANO_URL|$NANO_SHA256"
  "tzdata$TZDATA_VERSION.tar.gz|$TZDATA_URL|$TZDATA_SHA256"
  "libxcrypt-$LIBXCRYPT_VERSION.tar.xz|$LIBXCRYPT_URL|$LIBXCRYPT_SHA256"
)
for specification in "${archives[@]}"; do
  IFS='|' read -r filename url digest <<<"$specification"
  fetch "$url" "$upstream/$filename" "$digest"
done

apk_src=$source_root/apk-tools-v$APK_TOOLS_VERSION
dhcpcd_src=$source_root/dhcpcd-$DHCPCD_VERSION
libmnl_src=$source_root/libmnl-$LIBMNL_VERSION
libnftnl_src=$source_root/libnftnl-$LIBNFTNL_VERSION
nftables_src=$source_root/nftables-$NFTABLES_VERSION
chrony_src=$source_root/chrony-$CHRONY_VERSION
e2fsprogs_src=$source_root/e2fsprogs-$E2FSPROGS_VERSION
shadow_src=$source_root/shadow-$SHADOW_VERSION
libcap_src=$source_root/libcap-$LIBCAP_VERSION
acl_src=$source_root/acl-$ACL_VERSION
attr_src=$source_root/attr-$ATTR_VERSION
zstd_src=$source_root/zstd-$ZSTD_VERSION
ncurses_src=$source_root/ncurses-$NCURSES_VERSION
nano_src=$source_root/nano-$NANO_VERSION
tzdata_src=$source_root/tzdata-$TZDATA_VERSION
libxcrypt_src=$source_root/libxcrypt-$LIBXCRYPT_VERSION

extract_once "$upstream/apk-tools-v$APK_TOOLS_VERSION.tar.gz" "$apk_src"
extract_once "$upstream/dhcpcd-$DHCPCD_VERSION.tar.xz" "$dhcpcd_src"
extract_once "$upstream/libmnl-$LIBMNL_VERSION.tar.bz2" "$libmnl_src"
extract_once "$upstream/libnftnl-$LIBNFTNL_VERSION.tar.xz" "$libnftnl_src"
extract_once "$upstream/nftables-$NFTABLES_VERSION.tar.xz" "$nftables_src"
extract_once "$upstream/chrony-$CHRONY_VERSION.tar.gz" "$chrony_src"
extract_once "$upstream/e2fsprogs-$E2FSPROGS_VERSION.tar.xz" "$e2fsprogs_src"
extract_once "$upstream/shadow-$SHADOW_VERSION.tar.xz" "$shadow_src"
extract_once "$upstream/libcap-$LIBCAP_VERSION.tar.xz" "$libcap_src"
extract_once "$upstream/acl-$ACL_VERSION.tar.xz" "$acl_src"
extract_once "$upstream/attr-$ATTR_VERSION.tar.xz" "$attr_src"
extract_once "$upstream/zstd-$ZSTD_VERSION.tar.gz" "$zstd_src"
extract_once "$upstream/ncurses-$NCURSES_VERSION.tar.gz" "$ncurses_src"
extract_once "$upstream/nano-$NANO_VERSION.tar.xz" "$nano_src"
extract_tzdata_once "$upstream/tzdata$TZDATA_VERSION.tar.gz" "$tzdata_src"
extract_once "$upstream/libxcrypt-$LIBXCRYPT_VERSION.tar.xz" "$libxcrypt_src"

compiler_id=$($cc --version | sed -n '1p')
recipe_key=$(
  {
    for specification in "${archives[@]}"; do
      printf '%s\n' "${specification##*|}"
    done
    printf '%s\n' "$toolchain_digest" "$compiler_id" "$QM_BOOTSTRAP_ID" \
      'standard-system-providers-all-static-v2'
  } | sha256sum | cut -d' ' -f1
)
prefix=$build/packages/$recipe_key
objects=$object_root/$recipe_key
mkdir -p "$prefix" "$objects"

root_for() { printf '%s/%s-root\n' "$prefix" "$1"; }
object_for() { printf '%s/%s\n' "$objects" "$1"; }

base_cpp="-I$toolchain_root/usr/include"
base_ld="$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG -L$toolchain_root/usr/lib"
base_pc=$toolchain_root/usr/lib/pkgconfig

configure_static() {
  local source=$1 object=$2 root=$3
  shift 3
  if [[ -f $root/.complete ]]; then
    return
  fi
  mkdir -p "$object" "$root"
  (
    cd "$object"
    CC="$cc" CFLAGS='-O2 -std=gnu17' CPPFLAGS="$base_cpp" \
      LDFLAGS="-static $base_ld" PKG_CONFIG="$pkgconf" \
      PKG_CONFIG_LIBDIR="$base_pc" \
      "$source/configure" --prefix=/usr --bindir=/usr/bin \
        --sbindir=/usr/bin --libdir=/usr/lib \
        --disable-shared --enable-static "$@"
  )
  make -C "$object" LDFLAGS="-all-static $base_ld" -j"$jobs"
  make -C "$object" LDFLAGS="-all-static $base_ld" \
    DESTDIR="$root" install
  touch "$root/.complete"
}

attr_root=$(root_for attr)
attr_o=$(object_for attr)
configure_static "$attr_src" "$attr_o" "$attr_root" --disable-nls

acl_root=$(root_for acl)
acl_o=$(object_for acl)
if [[ ! -f $acl_root/.complete ]]; then
  mkdir -p "$acl_o" "$acl_root"
  (
    cd "$acl_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      CPPFLAGS="$base_cpp -I$attr_root/usr/include" \
      LDFLAGS="-static $base_ld -L$attr_root/usr/lib" \
      PKG_CONFIG="$pkgconf" \
      PKG_CONFIG_LIBDIR="$attr_root/usr/lib/pkgconfig:$base_pc" \
      "$acl_src/configure" --prefix=/usr --bindir=/usr/bin \
        --libdir=/usr/lib --disable-shared --enable-static --disable-nls
  )
  make -C "$acl_o" \
    LDFLAGS="-all-static $base_ld -L$attr_root/usr/lib" -j"$jobs"
  make -C "$acl_o" \
    LDFLAGS="-all-static $base_ld -L$attr_root/usr/lib" \
    DESTDIR="$acl_root" install
  touch "$acl_root/.complete"
fi

libxcrypt_recipe_key=$(
  printf '%s\n' 'libxcrypt-static-disable-werror-v1' |
    sha256sum | cut -d' ' -f1
)
libxcrypt_root=$prefix/libxcrypt-$libxcrypt_recipe_key-root
libxcrypt_o=$objects/libxcrypt-$libxcrypt_recipe_key
configure_static "$libxcrypt_src" "$libxcrypt_o" "$libxcrypt_root" \
  --disable-obsolete-api --disable-werror

libcap_recipe_key=$(
  printf '%s\n' 'libcap-static-construction-relocs-v2' |
    sha256sum | cut -d' ' -f1
)
libcap_root=$prefix/libcap-$libcap_recipe_key-root
if [[ ! -f $libcap_root/.complete ]]; then
  mkdir -p "$libcap_root"
  # libcap's progs/Makefile assigns LDFLAGS after Make.Rules, so a command-line
  # LDFLAGS does not reach getcap/setcap/getpcaps/capsh.  CFLAGS is also part
  # of every program link command; carry the construction contract there so
  # all published executables retain their code relocation population.
  make -C "$libcap_src" clean
  make -C "$libcap_src" -j"$jobs" BUILD_CC=cc CC="$cc" AR="$ar" \
    RANLIB="$ranlib" \
    COPTS="-O2 $base_cpp $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    LDFLAGS="-static $base_ld" \
    SHARED=no DYNAMIC=no PAM_CAP=no GOLANG=no lib=lib prefix=/usr
  make -C "$libcap_src" DESTDIR="$libcap_root" BUILD_CC=cc CC="$cc" \
    AR="$ar" RANLIB="$ranlib" \
    COPTS="-O2 $base_cpp $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    LDFLAGS="-static $base_ld" SHARED=no DYNAMIC=no PAM_CAP=no \
    GOLANG=no lib=lib sbin=bin prefix=/usr install
  touch "$libcap_root/.complete"
fi

libmnl_root=$(root_for libmnl)
libmnl_o=$(object_for libmnl)
configure_static "$libmnl_src" "$libmnl_o" "$libmnl_root"
rm -f "$libmnl_root/usr/lib/libmnl.la"

libnftnl_root=$(root_for libnftnl)
libnftnl_o=$(object_for libnftnl)
if [[ ! -f $libnftnl_root/.complete ]]; then
  mkdir -p "$libnftnl_o" "$libnftnl_root"
  (
    cd "$libnftnl_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      CPPFLAGS="$base_cpp -I$libmnl_root/usr/include" \
      LDFLAGS="-static $base_ld -L$libmnl_root/usr/lib" \
      PKG_CONFIG="$pkgconf" \
      PKG_CONFIG_LIBDIR="$libmnl_root/usr/lib/pkgconfig:$base_pc" \
      "$libnftnl_src/configure" --prefix=/usr --libdir=/usr/lib \
        --disable-shared --enable-static
  )
  make -C "$libnftnl_o" -j"$jobs"
  make -C "$libnftnl_o" DESTDIR="$libnftnl_root" install
  touch "$libnftnl_root/.complete"
fi
rm -f "$libnftnl_root/usr/lib/libnftnl.la"

nftables_recipe_key=$(
  printf '%s\n' 'nftables-static-archives-v3-bash-config-status' |
    sha256sum | cut -d' ' -f1
)
nftables_root=$prefix/nftables-$nftables_recipe_key-root
nftables_o=$objects/nftables-$nftables_recipe_key
if [[ ! -f $nftables_root/.complete ]]; then
  mkdir -p "$nftables_o" "$nftables_root"
  (
    cd "$nftables_o"
    # Upstream's generated nftversion.h action uses an arithmetic for loop.
    # Keep its configure and config.status on Bash, not the host's POSIX sh.
    export CONFIG_SHELL=/bin/bash
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      CPPFLAGS="$base_cpp -I$libmnl_root/usr/include -I$libnftnl_root/usr/include" \
      LDFLAGS="-static $base_ld" \
      LIBMNL_CFLAGS="-I$libmnl_root/usr/include" \
      LIBMNL_LIBS="$libmnl_root/usr/lib/libmnl.a" \
      LIBNFTNL_CFLAGS="-I$libnftnl_root/usr/include" \
      LIBNFTNL_LIBS="$libnftnl_root/usr/lib/libnftnl.a $libmnl_root/usr/lib/libmnl.a" \
      LIBS="-Wl,--start-group $libnftnl_root/usr/lib/libnftnl.a $libmnl_root/usr/lib/libmnl.a -Wl,--end-group" \
      PKG_CONFIG="$pkgconf" \
      PKG_CONFIG_LIBDIR="$libnftnl_root/usr/lib/pkgconfig:$libmnl_root/usr/lib/pkgconfig:$base_pc" \
      bash "$nftables_src/configure" --prefix=/usr --bindir=/usr/bin \
        --sbindir=/usr/bin --libdir=/usr/lib --disable-shared \
        --enable-static --disable-debug --disable-man-doc --with-mini-gmp \
        --without-cli --without-xtables --without-json
  )
  make -C "$nftables_o" LDFLAGS="-all-static $base_ld" -j"$jobs"
  make -C "$nftables_o" LDFLAGS="-all-static $base_ld" \
    DESTDIR="$nftables_root" install
  touch "$nftables_root/.complete"
fi

dhcpcd_root=$(root_for dhcpcd)
dhcpcd_o=$(object_for dhcpcd)
if [[ ! -f $dhcpcd_root/.complete ]]; then
  if [[ ! -f $dhcpcd_o/.qm-object-complete ]]; then
    if [[ -e $dhcpcd_o ]]; then
      printf 'incomplete dhcpcd object tree exists: %s\n' "$dhcpcd_o" >&2
      exit 1
    fi
    cp -a "$dhcpcd_src" "$dhcpcd_o"
    touch "$dhcpcd_o/.qm-object-complete"
  fi
  mkdir -p "$dhcpcd_root"
  (
    cd "$dhcpcd_o"
    CC="$cc" CFLAGS="-O2 -Wno-error=parentheses $base_cpp" \
      LDFLAGS="-static $base_ld" \
      ./configure --prefix=/usr --bindir=/usr/bin --sbindir=/usr/bin \
        --libexecdir=/usr/libexec --sysconfdir=/etc --dbdir=/var/lib/dhcpcd \
        --rundir=/run --without-udev --without-openssl
    make -j"$jobs"
    make DESTDIR="$dhcpcd_root" install
  )
  touch "$dhcpcd_root/.complete"
fi

chrony_root=$(root_for chrony)
chrony_o=$(object_for chrony)
if [[ ! -f $chrony_root/.complete ]]; then
  if [[ ! -f $chrony_o/.qm-object-complete ]]; then
    if [[ -e $chrony_o ]]; then
      printf 'incomplete chrony object tree exists: %s\n' "$chrony_o" >&2
      exit 1
    fi
    cp -a "$chrony_src" "$chrony_o"
    touch "$chrony_o/.qm-object-complete"
  fi
  mkdir -p "$chrony_root"
  (
    cd "$chrony_o"
    CC="$cc" CFLAGS="-O2 $base_cpp" LDFLAGS="-static $base_ld" \
      ./configure --prefix=/usr --bindir=/usr/bin --sbindir=/usr/bin \
        --sysconfdir=/etc --disable-readline --without-editline \
        --without-libcap --without-seccomp --disable-nts
    make -j"$jobs"
    make DESTDIR="$chrony_root" install
  )
  touch "$chrony_root/.complete"
fi

e2fsprogs_root=$(root_for e2fsprogs)
e2fsprogs_o=$(object_for e2fsprogs)
if [[ ! -f $e2fsprogs_root/.complete ]]; then
  mkdir -p "$e2fsprogs_o" "$e2fsprogs_root"
  (
    cd "$e2fsprogs_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' CPPFLAGS="$base_cpp" \
      LDFLAGS="-static $base_ld" \
      "$e2fsprogs_src/configure" --prefix=/usr --bindir=/usr/bin \
        --sbindir=/usr/bin --libdir=/usr/lib --disable-elf-shlibs \
        --enable-static --disable-nls --disable-debugfs --disable-imager \
        --disable-defrag --disable-uuidd --disable-fuse2fs \
        --disable-backtrace
  )
  make -C "$e2fsprogs_o" -j"$jobs"
  make -C "$e2fsprogs_o" DESTDIR="$e2fsprogs_root" install
  touch "$e2fsprogs_root/.complete"
fi

shadow_recipe_key=$(
  printf '%s\n' 'shadow-static-public-bin-v2' |
    sha256sum | cut -d' ' -f1
)
shadow_root=$prefix/shadow-$shadow_recipe_key-root
shadow_o=$(object_for shadow)
if [[ ! -f $shadow_root/.complete ]]; then
  mkdir -p "$shadow_o" "$shadow_root"
  (
    cd "$shadow_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      CPPFLAGS="$base_cpp -I$libxcrypt_root/usr/include" \
      LDFLAGS="-static $base_ld -L$libxcrypt_root/usr/lib" \
      PKG_CONFIG="$pkgconf" \
      PKG_CONFIG_LIBDIR="$libxcrypt_root/usr/lib/pkgconfig:$base_pc" \
      "$shadow_src/configure" --prefix=/usr --bindir=/usr/bin \
        --sbindir=/usr/bin --libdir=/usr/lib --disable-shared \
        --enable-static --disable-nls --disable-man --without-libpam \
        --disable-logind \
        --without-audit --without-selinux --without-acl --without-attr \
        --without-btrfs --without-nscd --without-sssd --without-libbsd
  )
  make -C "$shadow_o" \
    LDFLAGS="-all-static $base_ld -L$libxcrypt_root/usr/lib" -j"$jobs"
  make -C "$shadow_o" \
    LDFLAGS="-all-static $base_ld -L$libxcrypt_root/usr/lib" \
    DESTDIR="$shadow_root" install
  # Shadow installs administrative programs in /usr/sbin even when its
  # configure summary accepted --sbindir.  The distribution provider ABI is
  # one /usr/bin namespace; normalize the package before optimization so no
  # alternate runtime lookup path survives publication.
  install -d -m 0755 "$shadow_root/usr/bin"
  for program in groupadd useradd userdel usermod; do
    mv "$shadow_root/usr/sbin/$program" "$shadow_root/usr/bin/$program"
  done
  rmdir "$shadow_root/usr/sbin" 2>/dev/null || true
  touch "$shadow_root/.complete"
fi

zstd_recipe_key=$(
  printf '%s\n' 'zstd-static-cli-v1' | sha256sum | cut -d' ' -f1
)
zstd_root=$prefix/zstd-$zstd_recipe_key-root
zstd_o=$objects/zstd-$zstd_recipe_key
if [[ ! -f $zstd_root/.complete ]]; then
  if [[ ! -f $zstd_o/.qm-object-complete ]]; then
    if [[ -e $zstd_o ]]; then
      printf 'incomplete zstd object tree exists: %s\n' "$zstd_o" >&2
      exit 1
    fi
    cp -a "$zstd_src" "$zstd_o"
    touch "$zstd_o/.qm-object-complete"
  fi
  mkdir -p "$zstd_root"
  make -C "$zstd_o" -j"$jobs" CC="$cc" AR="$ar" \
    CFLAGS='-O2' \
    LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    ZSTD_LEGACY_SUPPORT=0 zstd
  make -C "$zstd_o/lib" CC="$cc" AR="$ar" DESTDIR="$zstd_root" \
    PREFIX=/usr ZSTD_LEGACY_SUPPORT=0 \
    install-pc install-static install-includes
  make -C "$zstd_o/programs" CC="$cc" AR="$ar" \
    DESTDIR="$zstd_root" PREFIX=/usr ZSTD_LEGACY_SUPPORT=0 install
  touch "$zstd_root/.complete"
fi

ncurses_root=$(root_for ncurses)
ncurses_o=$(object_for ncurses)
if [[ ! -f $ncurses_root/.complete ]]; then
  mkdir -p "$ncurses_o" "$ncurses_root"
  (
    cd "$ncurses_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' CPPFLAGS="$base_cpp" \
      LDFLAGS="-static $base_ld" \
      "$ncurses_src/configure" --prefix=/usr --bindir=/usr/bin \
        --libdir=/usr/lib --disable-shared --with-normal \
        --without-debug --without-ada --without-cxx --without-cxx-binding \
        --without-tests --without-manpages --enable-widec \
        --with-terminfo-dirs=/usr/share/terminfo
  )
  make -C "$ncurses_o" -j"$jobs"
  make -C "$ncurses_o" DESTDIR="$ncurses_root" install
  touch "$ncurses_root/.complete"
fi

nano_recipe_key=$(
  printf '%s\n' 'nano-ncurses-root-include-v1' | sha256sum | cut -d' ' -f1
)
nano_root=$prefix/nano-$nano_recipe_key-root
nano_o=$objects/nano-$nano_recipe_key
if [[ ! -f $nano_root/.complete ]]; then
  mkdir -p "$nano_o" "$nano_root"
  (
    cd "$nano_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      CPPFLAGS="$base_cpp -I$ncurses_root/usr/include" \
      LDFLAGS="-static $base_ld -L$ncurses_root/usr/lib" \
      PKG_CONFIG="$pkgconf" \
      PKG_CONFIG_LIBDIR="$ncurses_root/usr/lib/pkgconfig:$base_pc" \
      "$nano_src/configure" --prefix=/usr --bindir=/usr/bin \
        --disable-nls --disable-browser --disable-help \
        --disable-histories --disable-justify --disable-libmagic \
        --disable-mouse --disable-operatingdir --disable-speller
  )
  make -C "$nano_o" -j"$jobs"
  make -C "$nano_o" DESTDIR="$nano_root" install
  touch "$nano_root/.complete"
fi

. "$data/bootstrap/tzcode.env"
[[ $TZCODE_VERSION == "$TZDATA_VERSION" ]]
tzcode_archive=$upstream/tzcode$TZCODE_VERSION.tar.gz
fetch "$TZCODE_URL" "$tzcode_archive" "$TZCODE_SHA256"
tzcode_src=$source_root/tzcode-$TZCODE_VERSION
extract_tzdata_once "$tzcode_archive" "$tzcode_src"
tzdata_recipe_key=$(printf '%s\n' "$TZCODE_SHA256" "$TZDATA_SHA256" \
  "$compiler_id" "$QM_BOOTSTRAP_ID" 'zic-source-paired-v1' | sha256sum | cut -d' ' -f1)
tzdata_root=$prefix/tzdata-$tzdata_recipe_key-root
if [[ ! -f $tzdata_root/.complete ]]; then
  # Build the exact data compiler instead of depending on an untracked host
  # zic. This tool remains in the build tree and is not a release executable.
  make -C "$tzcode_src" CC="$cc" CFLAGS='-O2' \
    VERSION="$TZCODE_VERSION" VERSION_DEPS= zic
  zoneinfo=$tzdata_root/usr/share/zoneinfo
  mkdir -p "$zoneinfo"
  make -C "$tzdata_src" VERSION="$TZDATA_VERSION" VERSION_DEPS= \
    PACKRATDATA=backzone PACKRATLIST=zone.tab tzdata.zi
  "$tzcode_src/zic" -d "$zoneinfo" "$tzdata_src/tzdata.zi"
  install -m 644 "$tzdata_src/iso3166.tab" "$tzdata_src/zone.tab" \
    "$tzdata_src/zone1970.tab" "$zoneinfo"
  touch "$tzdata_root/.complete"
fi

apk_root=$(root_for apk-tools)
apk_o=$(object_for apk-tools)
if [[ ! -f $apk_root/.complete ]]; then
  mkdir -p "$apk_root"
  dependency_pc="$zstd_root/usr/lib/pkgconfig:$toolchain_root/usr/lib/pkgconfig"
  CC="$cc" CFLAGS='-O2 -std=gnu17' \
    CPPFLAGS="$base_cpp -I$zstd_root/usr/include" \
    LDFLAGS="-static $base_ld -L$zstd_root/usr/lib" \
    PKG_CONFIG="$pkgconf" PKG_CONFIG_LIBDIR="$dependency_pc" \
    "$meson" setup --wipe --prefix=/usr --bindir=bin --sbindir=bin \
      --libdir=lib --default-library=static -Dprefer_static=true \
      -Dc_link_args="-static $base_ld -L$zstd_root/usr/lib" \
      -Ddocs=disabled -Dhelp=disabled -Dlua=disabled -Dpython=disabled \
      -Dtests=disabled -Dzstd=enabled -Durl_backend=libfetch \
      "$apk_o" "$apk_src"
  "$ninja" -C "$apk_o"
  DESTDIR="$apk_root" "$meson" install -C "$apk_o"
  touch "$apk_root/.complete"
fi

package_roots=(
  "apk-tools:$apk_root" "dhcpcd:$dhcpcd_root"
  "libmnl:$libmnl_root" "libnftnl:$libnftnl_root"
  "nftables:$nftables_root" "chrony:$chrony_root"
  "e2fsprogs:$e2fsprogs_root" "shadow:$shadow_root"
  "libcap:$libcap_root" "acl:$acl_root" "attr:$attr_root"
  "zstd:$zstd_root" "ncurses:$ncurses_root" "nano:$nano_root"
  "tzdata:$tzdata_root" "libxcrypt:$libxcrypt_root"
)
publication_key=$(
  {
    printf '%s\n' "$recipe_key" \
      'component-linked-standard-system-package-set-v4'
    sha256sum "$here/build-system-tools.sh" \
      "$data/config/nftables.conf" "$data/config/ssh_config" \
      "$data/config/hosts" "$data/config/mdev.conf" \
      "$data/config/passwd" "$data/config/group" \
      "$data/config/shadow" "$data/config/gshadow" | \
      cut -d' ' -f1
    for specification in "${package_roots[@]}"; do
      name=${specification%%:*}
      package_root=${specification#*:}
      printf '%s:%s\n' "$name" "$(basename -- "$package_root")"
    done
  } | sha256sum | cut -d' ' -f1
)
publication=$build/publications/$publication_key
prepared_root=$publication/prepared
candidate=$publication/root.partial
root=$publication/root

prune_runtime_payload() {
  local name=$1 payload=$2
  rm -rf "$payload/usr/include" "$payload/usr/lib/pkgconfig" \
    "$payload/usr/lib/cmake" "$payload/usr/share/doc" \
    "$payload/usr/share/info" "$payload/usr/share/man" \
    "$payload/usr/share/locale"
  find "$payload/usr/lib" -type f \
    \( -name '*.a' -o -name '*.la' \) -delete 2>/dev/null || true
  case $name in
    e2fsprogs)
      find "$payload/usr/bin" -maxdepth 1 -type f \
        ! -name e2fsck ! -name mke2fs ! -name resize2fs -delete
      ;;
    shadow)
      find "$payload/usr/bin" -maxdepth 1 -type f \
        ! -name passwd ! -name su ! -name groupadd ! -name useradd \
        ! -name userdel ! -name usermod -delete
      # sg is only an alias for newgrp; newgrp is not part of this profile.
      rm -f "$payload/usr/bin/sg"
      ;;
    libcap)
      find "$payload/usr/bin" -maxdepth 1 -type f \
        ! -name getcap ! -name setcap -delete
      ;;
    acl)
      find "$payload/usr/bin" -maxdepth 1 -type f \
        ! -name getfacl ! -name setfacl -delete
      ;;
    attr)
      find "$payload/usr/bin" -maxdepth 1 -type f \
        ! -name getfattr ! -name setfattr -delete
      ;;
    ncurses)
      rm -rf "$payload/usr/bin"
      ;;
  esac
}

if [[ ! -f $publication/.complete ]]; then
  if [[ -e $prepared_root || -e $candidate || -e $root ]]; then
    printf 'incomplete system-tools publication exists: %s\n' \
      "$publication" >&2
    exit 1
  fi
  mkdir -p "$publication" "$candidate" "$prepared_root"
  for specification in "${package_roots[@]}"; do
    name=${specification%%:*}
    package_root=${specification#*:}
    prepared=$prepared_root/$name
    bash "$here/clone-tree.sh" "$package_root" "$prepared"
    find "$prepared" -name .complete -delete
    prune_runtime_payload "$name" "$prepared"
    bash "$here/clone-tree.sh" "$prepared" "$candidate"
  done
  config_root=$prepared_root/system-config
  install -D -m 0644 "$data/config/nftables.conf" \
    "$config_root/etc/nftables.conf"
  install -D -m 0644 "$data/config/ssh_config" \
    "$config_root/etc/ssh/ssh_config"
  install -D -m 0644 "$data/config/hosts" "$config_root/etc/hosts"
  install -D -m 0644 "$data/config/mdev.conf" "$config_root/etc/mdev.conf"
  install -D -m 0644 "$data/config/passwd" "$config_root/etc/passwd"
  install -D -m 0644 "$data/config/group" "$config_root/etc/group"
  install -D -m 0600 "$data/config/shadow" "$config_root/etc/shadow"
  install -D -m 0600 "$data/config/gshadow" "$config_root/etc/gshadow"
  install -d -m 0700 "$config_root/root"
  bash "$here/clone-tree.sh" "$config_root" "$candidate"

  # These are analysis-root coordinates only.  The product world, installed
  # database, repository selection, and trust roots are created by the signed
  # apk transaction and are not owned by this component package set.
  install -d -m 0755 "$candidate/etc/apk" "$candidate/etc/apk/keys" \
    "$candidate/lib/apk/db" "$candidate/var/cache/apk" \
    "$candidate/var/lib/dhcpcd" "$candidate/etc/ssh"
  rm -f "$candidate/etc/apk/repositories" "$candidate/etc/apk/world"
  : >"$candidate/etc/apk/repositories"
  : >"$candidate/etc/apk/world"
  mv -- "$candidate" "$root"
  touch "$publication/.complete"
fi

required=(
  usr/bin/apk usr/bin/dhcpcd usr/bin/nft usr/bin/chronyc usr/bin/chronyd
  usr/bin/e2fsck usr/bin/mke2fs usr/bin/resize2fs
  usr/bin/passwd usr/bin/su usr/bin/groupadd usr/bin/useradd
  usr/bin/userdel usr/bin/usermod usr/bin/getcap usr/bin/setcap
  usr/bin/getfacl usr/bin/setfacl usr/bin/getfattr usr/bin/setfattr
  usr/bin/zstd usr/bin/nano usr/share/zoneinfo/UTC
  etc/apk/repositories etc/apk/world etc/nftables.conf etc/ssh/ssh_config
  etc/hosts etc/mdev.conf
  etc/passwd etc/group etc/shadow etc/gshadow root
)
for path in "${required[@]}"; do
  if [[ ! -e $root/$path ]]; then
    printf 'system-tools path is missing: /%s\n' "$path" >&2
    exit 1
  fi
done

package_outputs=("system-config:$prepared_root/system-config")
for specification in "${package_roots[@]}"; do
  name=${specification%%:*}
  # These static-link inputs have no residual runtime payload after pruning;
  # their semantics are already inside the owning consumer ELF.  Publishing
  # empty packages would retain only solver/database fixed cost.
  case $name in
    libmnl|libnftnl|libxcrypt) continue ;;
  esac
  package_outputs+=("$name:$prepared_root/$name")
done
bash "$here/emit-package-set.sh" "$out" \
  x86_64-linux-musl-system-tools "$publication_key" \
  "${package_outputs[@]}" >&3
