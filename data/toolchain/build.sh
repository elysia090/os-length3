#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
repo=$(cd -- "$data/.." && pwd)

. "$data/bootstrap/environment.sh"
. "$data/sources.env"
. "$data/distribution/profile.env"

upstream="$data/upstream"
# Completed package roots and publications are durable repository build state.
# Keep those on the Windows side.  Expanded source and compiler objects are
# reconstructible scratch: placing their many small files on NTFS dominated an
# initial build without adding identity or recovery value.
build=${QM_TOOLCHAIN_BUILD_ROOT:-$repo/temp/toolchain-build}
work=${QM_TOOLCHAIN_WORK_ROOT:-${QM_SCRATCH_ROOT:-${TMPDIR:-/tmp}}/libqm-toolchain-work}
source_root=$work/sources
out=${QM_OUTPUT_ROOT:-$repo/temp/toolchain-output}
jobs=${QM_JOBS:-$(nproc)}
mkdir -p "$upstream" "$build" "$source_root" "$work/objects" "$out"

fetch() {
  local url=$1 output=$2 expected=$3
  if [[ ! -f $output ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$output.part" "$url"
    mv "$output.part" "$output"
  fi
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status
}

verify_sha512() {
  local input=$1 expected=$2
  printf '%s  %s\n' "$expected" "$input" | sha512sum --check --status
}

fetch_sha512() {
  local url=$1 output=$2 expected=$3
  if [[ ! -f $output ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$output.part" "$url"
    mv "$output.part" "$output"
  fi
  verify_sha512 "$output" "$expected"
}

resolve_cc() {
  bootstrap_cc "${QM_TOOLCHAIN_CC:-}"
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

extract_linux_headers_once() {
  local archive=$1 directory=$2 marker=$2/.qm-source-complete
  if [[ -f $marker ]]; then
    return
  fi
  if [[ -e $directory ]]; then
    printf 'incomplete Linux header source checkpoint exists: %s\n' \
      "$directory" >&2
    return 1
  fi
  # headers_install has no dependency on drivers, filesystems or networking.
  # Extracting the full kernel tree here added hundreds of MiB of unrelated
  # NTFS writes to every new build checkpoint.  Keep exactly the source closure
  # of the exported x86 UAPI target; the boot-kernel recipe owns the full tree.
  tar -C "$source_root" --no-same-owner -xf "$archive" \
    "linux-$LINUX_VERSION/Makefile" \
    "linux-$LINUX_VERSION/Kbuild" \
    "linux-$LINUX_VERSION/Kconfig" \
    "linux-$LINUX_VERSION/scripts" \
    "linux-$LINUX_VERSION/include" \
    "linux-$LINUX_VERSION/arch/x86/Makefile" \
    "linux-$LINUX_VERSION/arch/x86/include" \
    "linux-$LINUX_VERSION/arch/x86/entry/syscalls"
  touch "$marker"
}

configure_make_install() {
  local source=$1 object=$2 root=$3
  shift 3
  if [[ -f $root/.complete ]]; then
    return
  fi
  mkdir -p "$object" "$root"
  (
    cd "$object"
    CC="$cc" CXX="$cxx" CFLAGS='-O2 -std=gnu17' CXXFLAGS='-O2' \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$source/configure" --prefix=/usr "$@"
  )
  make -C "$object" -j"$jobs"
  make -C "$object" DESTDIR="$root" install
  touch "$root/.complete"
}

cc=$(resolve_cc)
cxx="$(dirname -- "$cc")/g++"
if [[ ! -x $cxx ]]; then
  printf 'toolchain C++ compiler not found beside %s\n' "$cc" >&2
  exit 1
fi
target=$($cc -dumpmachine)
case $target in
  x86_64-*-linux-musl) ;;
  *)
    printf 'toolchain compiler must target x86_64 Linux musl, got %s\n' \
      "$target" >&2
    exit 1
    ;;
esac
ar=$(command -v ar)
ranlib=$(command -v ranlib)

linux_tar="$upstream/linux-$LINUX_VERSION.tar.xz"
make_tar="$upstream/make-$MAKE_VERSION.tar.gz"
musl_tar="$upstream/musl-$MUSL_VERSION.tar.gz"
binutils_tar="$upstream/binutils-with-gold-$BINUTILS_VERSION.tar.xz"
gcc_tar="$upstream/gcc-$GCC_VERSION.tar.xz"
gmp_tar="$upstream/gmp-$GMP_VERSION.tar.bz2"
mpfr_tar="$upstream/mpfr-$MPFR_VERSION.tar.bz2"
mpc_tar="$upstream/mpc-$MPC_VERSION.tar.gz"
gettext_tar="$upstream/gettext-$GETTEXT_VERSION.tar.gz"
zlib_tar="$upstream/zlib-$ZLIB_VERSION.tar.xz"
openssl_tar="$upstream/openssl-$OPENSSL_VERSION.tar.gz"
curl_tar="$upstream/curl-$CURL_VERSION.tar.xz"
git_tar="$upstream/git-$GIT_VERSION.tar.xz"
tar_tar="$upstream/tar-$TAR_VERSION.tar.xz"
gzip_tar="$upstream/gzip-$GZIP_VERSION.tar.xz"
xz_tar="$upstream/xz-$XZ_VERSION.tar.xz"
bzip2_tar="$upstream/bzip2-$BZIP2_VERSION.tar.gz"
patch_tar="$upstream/patch-$PATCH_VERSION.tar.xz"
file_tar="$upstream/file-$FILE_VERSION.tar.gz"
pkgconf_tar="$upstream/pkgconf-$PKGCONF_VERSION.tar.xz"
openssh_tar="$upstream/openssh-$OPENSSH_VERSION.tar.gz"
ca_certificates="$upstream/cacert-$CA_CERTIFICATES_DATE.pem"

fetch "$LINUX_URL" "$linux_tar" "$LINUX_SHA256"
fetch "$MAKE_URL" "$make_tar" "$MAKE_SHA256"
fetch "$MUSL_URL" "$musl_tar" "$MUSL_SHA256"
fetch "$BINUTILS_URL" "$binutils_tar" "$BINUTILS_SHA256"
fetch "$GCC_URL" "$gcc_tar" "$GCC_SHA256"
verify_sha512 "$gcc_tar" "$GCC_SHA512"
fetch_sha512 "$GMP_URL" "$gmp_tar" "$GMP_SHA512"
fetch_sha512 "$MPFR_URL" "$mpfr_tar" "$MPFR_SHA512"
fetch_sha512 "$MPC_URL" "$mpc_tar" "$MPC_SHA512"
fetch_sha512 "$GETTEXT_URL" "$gettext_tar" "$GETTEXT_SHA512"
fetch "$ZLIB_URL" "$zlib_tar" "$ZLIB_SHA256"
fetch "$OPENSSL_URL" "$openssl_tar" "$OPENSSL_SHA256"
fetch "$CURL_URL" "$curl_tar" "$CURL_SHA256"
fetch "$GIT_URL" "$git_tar" "$GIT_SHA256"
fetch "$TAR_URL" "$tar_tar" "$TAR_SHA256"
fetch "$GZIP_URL" "$gzip_tar" "$GZIP_SHA256"
fetch "$XZ_URL" "$xz_tar" "$XZ_SHA256"
fetch "$BZIP2_URL" "$bzip2_tar" "$BZIP2_SHA256"
fetch "$PATCH_URL" "$patch_tar" "$PATCH_SHA256"
fetch "$FILE_URL" "$file_tar" "$FILE_SHA256"
fetch "$PKGCONF_URL" "$pkgconf_tar" "$PKGCONF_SHA256"
fetch "$OPENSSH_URL" "$openssh_tar" "$OPENSSH_SHA256"
fetch "$CA_CERTIFICATES_URL" "$ca_certificates" \
  "$CA_CERTIFICATES_SHA256"

linux_src="$source_root/linux-$LINUX_VERSION"
make_src="$source_root/make-$MAKE_VERSION"
musl_src="$source_root/musl-$MUSL_VERSION"
binutils_src="$source_root/binutils-with-gold-$BINUTILS_VERSION"
gcc_src="$source_root/gcc-$GCC_VERSION"
gmp_src="$source_root/gmp-$GMP_VERSION"
mpfr_src="$source_root/mpfr-$MPFR_VERSION"
mpc_src="$source_root/mpc-$MPC_VERSION"
gettext_src="$source_root/gettext-$GETTEXT_VERSION"
zlib_src="$source_root/zlib-$ZLIB_VERSION"
openssl_src="$source_root/openssl-$OPENSSL_VERSION"
curl_src="$source_root/curl-$CURL_VERSION"
git_src="$source_root/git-$GIT_VERSION"
tar_src="$source_root/tar-$TAR_VERSION"
gzip_src="$source_root/gzip-$GZIP_VERSION"
xz_src="$source_root/xz-$XZ_VERSION"
bzip2_src="$source_root/bzip2-$BZIP2_VERSION"
patch_src="$source_root/patch-$PATCH_VERSION"
file_src="$source_root/file-$FILE_VERSION"
pkgconf_src="$source_root/pkgconf-$PKGCONF_VERSION"
openssh_src="$source_root/openssh-$OPENSSH_VERSION"

extract_linux_headers_once "$linux_tar" "$linux_src"
extract_once "$make_tar" "$make_src"
extract_once "$musl_tar" "$musl_src"
extract_once "$binutils_tar" "$binutils_src"
extract_once "$gcc_tar" "$gcc_src"
extract_once "$gmp_tar" "$gmp_src"
extract_once "$mpfr_tar" "$mpfr_src"
extract_once "$mpc_tar" "$mpc_src"
extract_once "$gettext_tar" "$gettext_src"
extract_once "$zlib_tar" "$zlib_src"
extract_once "$openssl_tar" "$openssl_src"
extract_once "$curl_tar" "$curl_src"
extract_once "$git_tar" "$git_src"
extract_once "$tar_tar" "$tar_src"
extract_once "$gzip_tar" "$gzip_src"
extract_once "$xz_tar" "$xz_src"
extract_once "$bzip2_tar" "$bzip2_src"
extract_once "$patch_tar" "$patch_src"
extract_once "$file_tar" "$file_src"
extract_once "$pkgconf_tar" "$pkgconf_src"
extract_once "$openssh_tar" "$openssh_src"

ln -sfn "../gmp-$GMP_VERSION" "$gcc_src/gmp"
ln -sfn "../mpfr-$MPFR_VERSION" "$gcc_src/mpfr"
ln -sfn "../mpc-$MPC_VERSION" "$gcc_src/mpc"
ln -sfn "../gettext-$GETTEXT_VERSION" "$gcc_src/gettext"

compiler_id=$($cc --version | sed -n '1p')
base_key=$(printf '%s\n' "$MAKE_SHA256" "$MUSL_SHA256" \
  "$BINUTILS_SHA256" "$compiler_id" "$QM_BOOTSTRAP_ID" \
  "$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
  'static-x86_64-musl-v2-gnu17' | \
  sha256sum | cut -d' ' -f1)
gcc_key=$(printf '%s\n' "$GCC_SHA256" "$GMP_SHA512" "$MPFR_SHA512" \
  "$MPC_SHA512" "$GETTEXT_SHA512" "$compiler_id" "$QM_BOOTSTRAP_ID" \
  "$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
  'native-static-c-no-lto-v2' | sha256sum | cut -d' ' -f1)
system_key=$(printf '%s\n' "$LINUX_SHA256" "$ZLIB_SHA256" \
  "$OPENSSL_SHA256" "$CURL_SHA256" "$GIT_SHA256" "$TAR_SHA256" \
  "$GZIP_SHA256" "$XZ_SHA256" "$BZIP2_SHA256" "$PATCH_SHA256" \
  "$FILE_SHA256" "$PKGCONF_SHA256" "$OPENSSH_SHA256" \
  "$CA_CERTIFICATES_SHA256" "$compiler_id" "$QM_BOOTSTRAP_ID" \
  "$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
  'posix-system-v2-gnu17' | \
  sha256sum | cut -d' ' -f1)
profile_key=$(sha256sum "$data/distribution/profile.env" \
  "$data/distribution/runtime-closure.tsv.in" \
  "$data/bootstrap/packages.sha256" "$data/bootstrap/installed.lock" | \
  sha256sum | cut -d' ' -f1)
# The release-metadata package contains the complete source lock, including
# packages built outside this toolchain. A change to any pinned input must
# republish that package even when every toolchain component can be reused.
source_lock=$(sha256sum "$data/sources.env" | cut -d' ' -f1)
distribution_key=$(printf '%s\n' "$base_key" "$gcc_key" "$system_key" \
  "$profile_key" "$source_lock" 'component-linked-toolchain-package-set-v4' | \
  sha256sum | cut -d' ' -f1)

base_prefix="$build/packages/$base_key"
base_objects="$work/objects/$base_key"
musl_o="$base_objects/musl"
musl_root="$base_prefix/musl-root"
make_o="$base_objects/make"
make_root="$base_prefix/make-root"
binutils_o="$base_objects/binutils"
binutils_root="$base_prefix/binutils-root"
gcc_prefix="$build/packages/$gcc_key"
gcc_o="$work/objects/$gcc_key/gcc"
gcc_root="$gcc_prefix/gcc-root"
system_prefix="$build/packages/$system_key"
system_objects="$work/objects/$system_key"
linux_headers_o="$system_objects/linux-headers"
linux_headers_root="$system_prefix/linux-headers-root"
zlib_o="$system_objects/zlib"
zlib_root="$system_prefix/zlib-root"
openssl_o="$system_objects/openssl"
openssl_root="$system_prefix/openssl-root"
pkgconf_o="$system_objects/pkgconf"
pkgconf_root="$system_prefix/pkgconf-root"
curl_o="$system_objects/curl"
curl_root="$system_prefix/curl-root"
git_o="$system_objects/git"
git_root="$system_prefix/git-root"
tar_o="$system_objects/tar"
tar_root="$system_prefix/tar-root"
gzip_o="$system_objects/gzip"
gzip_root="$system_prefix/gzip-root"
xz_o="$system_objects/xz"
xz_root="$system_prefix/xz-root"
bzip2_o="$system_objects/bzip2"
bzip2_root="$system_prefix/bzip2-root"
patch_o="$system_objects/patch"
patch_root="$system_prefix/patch-root"
file_o="$system_objects/file"
file_root="$system_prefix/file-root"
openssh_o="$system_objects/openssh"
openssh_root="$system_prefix/openssh-root"
distribution_prefix="$build/publications/$distribution_key"
linked_root="$distribution_prefix/linked-root"
stage="$distribution_prefix/root"
prepared_root="$distribution_prefix/packages"

if [[ ! -f $musl_root/.complete ]]; then
  mkdir -p "$musl_o" "$musl_root"
  (
    cd "$musl_o"
    CC="$cc" LDFLAGS="$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$musl_src/configure" \
      --prefix=/usr --syslibdir=/lib --disable-shared
  )
  make -C "$musl_o" -j"$jobs"
  make -C "$musl_o" DESTDIR="$musl_root" install
  touch "$musl_root/.complete"
fi

configure_make_install "$make_src" "$make_o" "$make_root" --disable-nls

binutils_recipe='libtool-all-static-v1'
if [[ ! -f $binutils_root/.complete ]] || \
   [[ $(<"$binutils_root/.complete") != "$binutils_recipe" ]]; then
  # Object trees are scratch, not checkpoints.  Reusing a configure tree from
  # an interrupted invocation can silently mix PKG_CONFIG/YACC and other Nix
  # bootstrap identities.  Only the installed root plus its recipe marker is
  # durable; an unmarked pair is discarded as one failed transaction.
  case $binutils_o:$binutils_root in
    "$work"/objects/*/binutils:"$build"/packages/*/binutils-root) ;;
    *)
      printf 'refusing to reset unexpected binutils paths: %s %s\n' \
        "$binutils_o" "$binutils_root" >&2
      exit 1
      ;;
  esac
  rm -rf -- "$binutils_o" "$binutils_root"
  mkdir -p "$binutils_o" "$binutils_root"
  (
    cd "$binutils_o"
    CC="$cc" CXX="$cxx" CFLAGS='-O2 -static' \
      CXXFLAGS='-O2 -static' \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      MAKEINFO=true "$binutils_src/configure" \
      --prefix=/usr --build="$target" --host="$target" --target="$target" \
      --disable-gold --disable-gdb --disable-gdbserver --disable-gprofng \
      --disable-libdecnumber --disable-nls --disable-readline --disable-shared \
      --disable-sim --disable-werror --enable-static --without-babeltrace \
      --without-debuginfod --without-zstd
  )
  # Keep the top-level/subconfigure environment stable.  Libtool interprets
  # -static as "prefer static libraries", not "produce a static executable",
  # so only the already-configured program subdirectories get -all-static.
  make -C "$binutils_o" MAKEINFO=true \
    LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" -j"$jobs" \
    all-binutils all-gas all-ld
  for directory in binutils gas ld; do
    make -C "$binutils_o/$directory" clean
    make -C "$binutils_o/$directory" MAKEINFO=true \
      LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      -j"$jobs"
  done
  make -C "$binutils_o" MAKEINFO=true \
    LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    DESTDIR="$binutils_root" \
    install-binutils install-gas install-ld
  printf '%s\n' "$binutils_recipe" > "$binutils_root/.complete"
fi

if [[ ! -f $gcc_root/.complete ]]; then
  # As above, a GCC object tree is not a resumable package checkpoint.  GCC's
  # recursive configure caches tool identities in each subdirectory, so an
  # interrupted tree must not cross invocations.
  case $gcc_o:$gcc_root in
    "$work"/objects/*/gcc:"$build"/packages/*/gcc-root) ;;
    *)
      printf 'refusing to reset unexpected gcc paths: %s %s\n' \
        "$gcc_o" "$gcc_root" >&2
      exit 1
      ;;
  esac
  rm -rf -- "$gcc_o" "$gcc_root"
  mkdir -p "$gcc_o" "$gcc_root"
  (
    cd "$gcc_o"
    PATH="$binutils_root/usr/bin:$PATH" \
      CC="$cc" CXX="$cxx" CFLAGS='-O2' CXXFLAGS='-O2' \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$gcc_src/configure" \
      --prefix=/usr --build="$target" --host="$target" --target="$target" \
      --enable-languages=c --disable-lto --disable-bootstrap --disable-multilib \
      --disable-nls --disable-shared --enable-static --disable-libatomic \
      --disable-libgomp --disable-libquadmath --disable-libsanitizer \
      --disable-libssp --disable-libstdcxx-pch --disable-libvtv \
      --without-isl --without-zstd --with-sysroot=/ \
      --with-build-sysroot="$musl_root" \
      --with-native-system-header-dir=/usr/include
  )
  PATH="$binutils_root/usr/bin:$PATH" \
    make -C "$gcc_o" -j"$jobs" all-gcc all-target-libgcc
  PATH="$binutils_root/usr/bin:$PATH" \
    make -C "$gcc_o" DESTDIR="$gcc_root" install-gcc install-target-libgcc
  touch "$gcc_root/.complete"
fi

# GCC installs lto-wrapper even when the compiler was configured with
# --disable-lto.  It is neither reachable from this C-only profile nor accepted
# by the published provider contract, so remove the complete LTO payload before
# package optimization and root assembly.  This keeps the package bytes and the
# declared feature closure identical on both clean and checkpointed builds.
find "$gcc_root" \( -type f -o -type l \) \
  \( -name lto1 -o -name lto-wrapper -o -name 'lto-dump*' \
     -o -name 'liblto_plugin*' \) -delete

if [[ ! -f $linux_headers_root/.complete ]]; then
  mkdir -p "$linux_headers_o" "$linux_headers_root"
  make -C "$linux_src" O="$linux_headers_o" ARCH=x86_64 \
    INSTALL_HDR_PATH="$linux_headers_root/usr" headers_install
  touch "$linux_headers_root/.complete"
fi

if [[ ! -f $zlib_root/.complete ]]; then
  mkdir -p "$zlib_o" "$zlib_root"
  (
    cd "$zlib_o"
    CC="$cc" CFLAGS='-O2 -static' \
      LDFLAGS="$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$zlib_src/configure" \
      --prefix=/usr --static
  )
  make -C "$zlib_o" -j"$jobs"
  make -C "$zlib_o" DESTDIR="$zlib_root" install
  touch "$zlib_root/.complete"
fi

openssl_recipe='static-no-pie-v2'
if [[ ! -f $openssl_root/.complete ]] || \
   [[ $(<"$openssl_root/.complete") != "$openssl_recipe" ]]; then
  mkdir -p "$openssl_o" "$openssl_root"
  if [[ -f $openssl_o/Makefile ]]; then
    make -C "$openssl_o" clean
  fi
  (
    cd "$openssl_o"
    CC="$cc" AR="$ar" RANLIB="$ranlib" \
      LDFLAGS="$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$openssl_src/Configure" linux-x86_64 \
      --prefix=/usr --libdir=lib --openssldir=/etc/ssl \
      no-shared no-tests no-module no-dso no-pic -static
  )
  make -C "$openssl_o" -j"$jobs"
  make -C "$openssl_o" DESTDIR="$openssl_root" install_sw
  printf '%s\n' "$openssl_recipe" > "$openssl_root/.complete"
fi

pkgconf_recipe='libtool-all-static-v1'
if [[ ! -f $pkgconf_root/.complete ]] || \
   [[ $(<"$pkgconf_root/.complete") != "$pkgconf_recipe" ]]; then
  mkdir -p "$pkgconf_o" "$pkgconf_root"
  if [[ -f $pkgconf_o/Makefile ]]; then
    make -C "$pkgconf_o" clean
  fi
  (
    cd "$pkgconf_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$pkgconf_src/configure" --prefix=/usr \
      --disable-shared --enable-static
  )
  make -C "$pkgconf_o" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" -j"$jobs"
  make -C "$pkgconf_o" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    DESTDIR="$pkgconf_root" install
  printf '%s\n' "$pkgconf_recipe" > "$pkgconf_root/.complete"
fi

dependency_cpp="-I$openssl_root/usr/include -I$zlib_root/usr/include"
dependency_ld="-L$openssl_root/usr/lib -L$zlib_root/usr/lib"
dependency_pc="$openssl_root/usr/lib/pkgconfig:$zlib_root/usr/lib/pkgconfig"
curl_recipe=$(
  {
    printf '%s\n' 'libtool-all-static-v2'
    sha256sum "$openssl_root/usr/lib/libssl.a" \
      "$openssl_root/usr/lib/libcrypto.a" "$zlib_root/usr/lib/libz.a"
  } | sha256sum | cut -d' ' -f1
)

if [[ ! -f $curl_root/.complete ]] || \
   [[ $(<"$curl_root/.complete") != "$curl_recipe" ]]; then
  mkdir -p "$curl_o" "$curl_root"
  if [[ -f $curl_o/src/Makefile ]]; then
    make -C "$curl_o/src" clean
  fi
  (
    cd "$curl_o"
    CC="$cc" CFLAGS='-O2' CPPFLAGS="$dependency_cpp" \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG $dependency_ld" \
      LIBS='-pthread' \
      PKG_CONFIG="$pkgconf_root/usr/bin/pkgconf" \
      PKG_CONFIG_LIBDIR="$dependency_pc" \
      "$curl_src/configure" --prefix=/usr \
      --disable-shared --enable-static --disable-docs --disable-manual \
      --disable-ldap --disable-ldaps --disable-rtsp \
      --with-openssl="$openssl_root/usr" --with-zlib="$zlib_root/usr" \
      --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt \
      --without-brotli --without-libidn2 --without-libpsl \
      --without-libssh2 --without-zstd
  )
  make -C "$curl_o" -j"$jobs" \
    CURL_LDFLAGS_BIN="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG"
  make -C "$curl_o" DESTDIR="$curl_root" \
    CURL_LDFLAGS_BIN="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" install
  printf '%s\n' "$curl_recipe" > "$curl_root/.complete"
fi

git_flags=(
    "CC=$cc"
    "AR=$ar"
    "CFLAGS=-O2 $dependency_cpp -I$curl_root/usr/include"
    "LDFLAGS=-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG $dependency_ld -L$curl_root/usr/lib"
    "CURL_CFLAGS=-I$curl_root/usr/include"
    "CURL_LDFLAGS=-L$curl_root/usr/lib -lcurl $dependency_ld -lssl -lcrypto -lz -pthread"
    "OPENSSLDIR=$openssl_root/usr"
    "OPENSSL_LINK=-L$openssl_root/usr/lib"
    NO_GETTEXT=YesPlease
    NO_TCLTK=YesPlease
    NO_PERL=YesPlease
    NO_PYTHON=YesPlease
    NO_EXPAT=YesPlease
    NO_REGEX=NeedsStartEnd
)
git_recipe=$(
  {
    printf '%s\n' 'static-no-runtime-languages-v3-build-only-rust'
    sha256sum "$data/bootstrap/rust.sh" "$data/bootstrap/rust.world" \
      "$data/bootstrap/rust.sha256" "$data/bootstrap/rust-installed.lock"
    sha256sum "$curl_root/usr/lib/libcurl.a" \
      "$openssl_root/usr/lib/libssl.a" \
      "$openssl_root/usr/lib/libcrypto.a" "$zlib_root/usr/lib/libz.a"
  } | sha256sum | cut -d' ' -f1
)
if [[ ! -f $git_root/.complete ]] || \
   [[ $(<"$git_root/.complete") != "$git_recipe" ]]; then
  bash "$data/bootstrap/rust.sh" install >&2
  mkdir -p "$git_o" "$git_root"
  if [[ ! -f $git_o/Makefile ]]; then
    cp -a "$git_src"/. "$git_o"/
  else
    make -C "$git_o" "${git_flags[@]}" clean
  fi
  bash "$data/bootstrap/rust.sh" run make -C "$git_o" -j"$jobs" "${git_flags[@]}" all
  bash "$data/bootstrap/rust.sh" run make -C "$git_o" DESTDIR="$git_root" prefix=/usr \
    "${git_flags[@]}" install
  printf '%s\n' "$git_recipe" > "$git_root/.complete"
fi

# This process is confined to the disposable build guest. GNU tar otherwise
# refuses to run its mknod configure probe as uid 0; permit that probe here,
# without changing the product's runtime policy or disabling release checks.
FORCE_UNSAFE_CONFIGURE=1 configure_make_install "$tar_src" "$tar_o" "$tar_root" --disable-nls
configure_make_install "$gzip_src" "$gzip_o" "$gzip_root" --disable-nls
xz_recipe='libtool-all-static-v1'
if [[ ! -f $xz_root/.complete ]] || \
   [[ $(<"$xz_root/.complete") != "$xz_recipe" ]]; then
  mkdir -p "$xz_o" "$xz_root"
  if [[ -f $xz_o/Makefile ]]; then
    make -C "$xz_o" clean
  fi
  (
    cd "$xz_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$xz_src/configure" --prefix=/usr \
      --disable-shared --enable-static --disable-nls --disable-doc
  )
  make -C "$xz_o" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" -j"$jobs"
  make -C "$xz_o" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    DESTDIR="$xz_root" install
  printf '%s\n' "$xz_recipe" > "$xz_root/.complete"
fi

bzip2_recipe='static-relative-links-v1'
if [[ ! -f $bzip2_root/.complete ]] || \
   [[ $(<"$bzip2_root/.complete") != "$bzip2_recipe" ]]; then
  mkdir -p "$bzip2_o" "$bzip2_root/usr"
  if [[ ! -f $bzip2_o/Makefile ]]; then
    cp -a "$bzip2_src"/. "$bzip2_o"/
  fi
  make -C "$bzip2_o" -j"$jobs" CC="$cc" AR="$ar" RANLIB="$ranlib" \
    CFLAGS='-O2 -static -D_FILE_OFFSET_BITS=64' \
    LDFLAGS="$DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG"
  make -C "$bzip2_o" PREFIX="$bzip2_root/usr" install
  ln -sfn bzdiff "$bzip2_root/usr/bin/bzcmp"
  ln -sfn bzgrep "$bzip2_root/usr/bin/bzegrep"
  ln -sfn bzgrep "$bzip2_root/usr/bin/bzfgrep"
  ln -sfn bzmore "$bzip2_root/usr/bin/bzless"
  printf '%s\n' "$bzip2_recipe" > "$bzip2_root/.complete"
fi

configure_make_install "$patch_src" "$patch_o" "$patch_root" --disable-nls
file_recipe='libtool-all-static-v1'
if [[ ! -f $file_root/.complete ]] || \
   [[ $(<"$file_root/.complete") != "$file_recipe" ]]; then
  mkdir -p "$file_o" "$file_root"
  if [[ -f $file_o/Makefile ]]; then
    make -C "$file_o" clean
  fi
  (
    cd "$file_o"
    CC="$cc" CFLAGS='-O2 -std=gnu17' \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
      "$file_src/configure" --prefix=/usr \
      --disable-shared --enable-static --disable-libseccomp
  )
  make -C "$file_o" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" -j"$jobs"
  make -C "$file_o" \
    LDFLAGS="-all-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG" \
    DESTDIR="$file_root" install
  printf '%s\n' "$file_recipe" > "$file_root/.complete"
fi

openssh_recipe=$(
  {
    printf '%s\n' 'static-client-v2'
    sha256sum "$openssl_root/usr/lib/libcrypto.a" "$zlib_root/usr/lib/libz.a"
  } | sha256sum | cut -d' ' -f1
)
if [[ ! -f $openssh_root/.complete ]] || \
   [[ $(<"$openssh_root/.complete") != "$openssh_recipe" ]]; then
  mkdir -p "$openssh_o" "$openssh_root/usr/bin"
  if [[ -f $openssh_o/Makefile ]]; then
    make -C "$openssh_o" clean
  fi
  (
    cd "$openssh_o"
    CC="$cc" CFLAGS='-O2' CPPFLAGS="$dependency_cpp" \
      LDFLAGS="-static $DISTRIBUTION_POSTLINK_INPUT_DRIVER_FLAG $dependency_ld" \
      LIBS='-pthread' \
      "$openssh_src/configure" --prefix=/usr --sysconfdir=/etc/ssh \
      --with-ssl-dir="$openssl_root/usr" --with-zlib="$zlib_root/usr" \
      --without-pam --without-kerberos5 --without-libedit \
      --without-ldns --without-selinux --without-zstd
  )
  make -C "$openssh_o" -j"$jobs" \
    ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan
  for client in ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan; do
    install -m 0755 "$openssh_o/$client" "$openssh_root/usr/bin/$client"
  done
  printf '%s\n' "$openssh_recipe" > "$openssh_root/.complete"
fi

package_specs=(
  "musl:$musl_root" "linux-headers:$linux_headers_root"
  "make:$make_root" "binutils:$binutils_root" "gcc:$gcc_root"
  "zlib:$zlib_root" "openssl:$openssl_root" "pkgconf:$pkgconf_root"
  "curl:$curl_root" "git:$git_root" "tar:$tar_root"
  "gzip:$gzip_root" "xz:$xz_root" "bzip2:$bzip2_root"
  "patch:$patch_root" "file:$file_root" "openssh-client:$openssh_root"
)

assembled=$distribution_prefix/.assembled
if [[ ! -f $assembled ]]; then
  if [[ -e $linked_root || -e $stage || -e $prepared_root ]]; then
    printf 'incomplete toolchain publication exists: %s\n' \
      "$distribution_prefix" >&2
    exit 1
  fi
  mkdir -p "$distribution_prefix" "$linked_root" "$prepared_root"
  for specification in "${package_specs[@]}"; do
    name=${specification%%:*}
    package_root=${specification#*:}
    prepared=$prepared_root/$name
    bash "$data/distribution/clone-tree.sh" "$package_root" "$prepared"
    find "$prepared" -name .complete -delete
    rm -rf "$prepared/usr/share/doc" "$prepared/usr/share/info" \
      "$prepared/usr/share/locale" "$prepared/usr/share/man"
  done

  # Provider aliases belong to the provider package, not to the later merged
  # namespace.  This keeps apk ownership exact after post-link compilation.
  mkdir -p "$prepared_root/gcc/usr/bin" "$prepared_root/pkgconf/usr/bin"
  ln -sfn gcc "$prepared_root/gcc/usr/bin/cc"
  ln -sfn pkgconf "$prepared_root/pkgconf/usr/bin/pkg-config"

  # c_rehash requires Perl, which is deliberately outside the fixed profile.
  # The CA bundle is generated before packaging instead of by a post-install
  # script, so this helper is neither executable closure nor package payload.
  rm -f "$prepared_root/openssl/usr/bin/c_rehash"
  rm -rf "$prepared_root/git/usr/share/git-core/templates/hooks"
  # The standard profile is a Git client. Server endpoints and IMAP mail
  # submission are optional packages, not mandatory bytes in every workspace.
  for git_helper in git-daemon git-http-backend git-imap-send; do
    helper="$prepared_root/git/usr/libexec/git-core/$git_helper"
    if [[ ! -f $helper ]]; then
      printf 'expected optional Git helper is absent: %s\n' "$helper" >&2
      exit 1
    fi
    rm -f -- "$helper"
  done

  ca_root=$prepared_root/ca-certificates
  install -D -m 0644 "$ca_certificates" \
    "$ca_root/etc/ssl/certs/ca-certificates.crt"
  ln -sfn certs/ca-certificates.crt "$ca_root/etc/ssl/cert.pem"

  metadata_root=$prepared_root/release-metadata
  install -D -m 0644 "$data/sources.env" \
    "$metadata_root/usr/share/qm/sources.env"
  install -D -m 0644 "$data/distribution/profile.env" \
    "$metadata_root/usr/share/qm/distribution-profile.env"
  install -D -m 0644 "$data/bootstrap/packages.sha256" \
    "$metadata_root/usr/share/qm/bootstrap-packages.sha256"
  install -D -m 0644 "$data/bootstrap/installed.lock" \
    "$metadata_root/usr/share/qm/bootstrap-installed.lock"
  mkdir -p "$metadata_root/usr/share/qm"
  sed -e "s|@TARGET@|$target|g" \
      -e "s|@GCC_VERSION@|$GCC_VERSION|g" \
      "$data/distribution/runtime-closure.tsv.in" \
      >"$metadata_root/usr/share/qm/runtime-closure.tsv"
  if ! LC_ALL=C tail -n +2 \
       "$metadata_root/usr/share/qm/runtime-closure.tsv" \
       | LC_ALL=C sort -c -u; then
    printf 'generated runtime closure manifest is not canonical\n' >&2
    exit 1
  fi

  package_outputs=(
    "ca-certificates:$ca_root"
    "release-metadata:$metadata_root"
  )
  for specification in "${package_specs[@]}"; do
    name=${specification%%:*}
    package_outputs+=("$name:$prepared_root/$name")
  done
  for specification in "${package_outputs[@]}"; do
    package_root=${specification#*:}
    bash "$data/distribution/clone-tree.sh" "$package_root" "$linked_root"
  done
  absolute_link=$(find "$linked_root" -type l -lname '/*' -print -quit)
  if [[ -n $absolute_link ]]; then
    printf 'staged system has a host-absolute symlink: %s -> %s\n' \
      "$absolute_link" "$(readlink "$absolute_link")" >&2
    exit 1
  fi
  mv -- "$linked_root" "$stage"
  touch "$assembled"
fi

smoke="$distribution_prefix/smoke"
mkdir -p "$smoke"
PATH="$stage/usr/bin:$PATH" "$stage/usr/bin/gcc" \
  --sysroot="$stage" -static -O2 "$here/smoke.c" -o "$smoke/hello"
if [[ $($smoke/hello) != QM-GCC-OK ]]; then
  printf 'staged GCC smoke test failed\n' >&2
  exit 1
fi

required=(
  usr/bin/cc usr/bin/gcc usr/bin/as usr/bin/ld usr/bin/make
  usr/bin/git usr/bin/curl usr/bin/ssh usr/bin/scp usr/bin/sftp
  usr/libexec/git-core/git-remote-http
  usr/libexec/git-core/git-remote-https
  usr/bin/tar usr/bin/gzip usr/bin/xz usr/bin/bzip2 usr/bin/patch
  usr/bin/file usr/bin/pkgconf usr/bin/pkg-config
  usr/include/stdio.h usr/include/linux/version.h usr/include/asm/unistd.h
  etc/ssl/certs/ca-certificates.crt usr/share/misc/magic.mgc
  usr/share/qm/sources.env
)
for path in "${required[@]}"; do
  if [[ ! -e $stage/$path ]]; then
    printf 'staged system path is missing: /%s\n' "$path" >&2
    exit 1
  fi
done

forbidden_lto=$(find "$stage" -type f \
  \( -name lto1 -o -name lto-wrapper -o -name 'lto-dump*' \
     -o -name 'liblto_plugin*' \) -print -quit)
if [[ -n $forbidden_lto ]]; then
  printf 'C-only distribution contains an LTO payload: %s\n' \
    "$forbidden_lto" >&2
  exit 1
fi

if ! bash "$here/audit-static.sh" "$stage"; then
  printf 'guest tools above have dynamic interpreters\n' >&2
  exit 1
fi

if [[ $($stage/usr/bin/git --version) != "git version $GIT_VERSION" ]]; then
  printf 'staged Git smoke test failed\n' >&2
  exit 1
fi
if ! SSL_CERT_FILE="$stage/etc/ssl/certs/ca-certificates.crt" \
    "$stage/usr/bin/curl" --version >/dev/null; then
  printf 'staged curl smoke test failed\n' >&2
  exit 1
fi

population="$out/x86_64-linux-musl-system-$distribution_key.population"
bash "$data/distribution/measure-root.sh" "$stage" "$population"

package_outputs=(
  "ca-certificates:$prepared_root/ca-certificates"
  "release-metadata:$prepared_root/release-metadata"
)
for specification in "${package_specs[@]}"; do
  name=${specification%%:*}
  package_outputs+=("$name:$prepared_root/$name")
done
package_set=$(bash "$data/distribution/emit-package-set.sh" "$out" \
  x86_64-linux-musl-toolchain "$distribution_key" \
  "${package_outputs[@]}")
touch "$distribution_prefix/.complete"
printf '%s\n' "$package_set" "$population"
