#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
data=$(cd -- "$here/.." && pwd)
. "$data/sources.env"

upstream="$data/upstream"
build=${QM_TOOLCHAIN_BUILD_ROOT:-${TMPDIR:-/tmp}/libqm-toolchain-build}
out=${QM_OUTPUT_ROOT:-${TMPDIR:-/tmp}/libqm-toolchain-output}
jobs=${QM_JOBS:-$(nproc)}
mkdir -p "$upstream" "$build" "$out"

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

resolve_cc() {
  if [[ -n ${QM_TOOLCHAIN_CC:-} ]]; then
    printf '%s\n' "$QM_TOOLCHAIN_CC"
    return
  fi
  if command -v nix >/dev/null 2>&1; then
    local candidate
    while IFS= read -r candidate; do
      if [[ -x $candidate/bin/gcc ]]; then
        printf '%s\n' "$candidate/bin/gcc"
        return
      fi
    done < <(nix build --no-link --print-out-paths nixpkgs#pkgsMusl.gcc)
  fi
  command -v musl-gcc
}

extract_once() {
  local archive=$1 directory=$2
  if [[ ! -d $directory ]]; then
    tar -C "$build" -xf "$archive"
  fi
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
      LDFLAGS='-static' "$source/configure" --prefix=/usr "$@"
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

linux_src="$build/linux-$LINUX_VERSION"
make_src="$build/make-$MAKE_VERSION"
musl_src="$build/musl-$MUSL_VERSION"
binutils_src="$build/binutils-with-gold-$BINUTILS_VERSION"
gcc_src="$build/gcc-$GCC_VERSION"
zlib_src="$build/zlib-$ZLIB_VERSION"
openssl_src="$build/openssl-$OPENSSL_VERSION"
curl_src="$build/curl-$CURL_VERSION"
git_src="$build/git-$GIT_VERSION"
tar_src="$build/tar-$TAR_VERSION"
gzip_src="$build/gzip-$GZIP_VERSION"
xz_src="$build/xz-$XZ_VERSION"
bzip2_src="$build/bzip2-$BZIP2_VERSION"
patch_src="$build/patch-$PATCH_VERSION"
file_src="$build/file-$FILE_VERSION"
pkgconf_src="$build/pkgconf-$PKGCONF_VERSION"
openssh_src="$build/openssh-$OPENSSH_VERSION"

extract_once "$linux_tar" "$linux_src"
extract_once "$make_tar" "$make_src"
extract_once "$musl_tar" "$musl_src"
extract_once "$binutils_tar" "$binutils_src"
extract_once "$gcc_tar" "$gcc_src"
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

if [[ ! -L $gcc_src/gmp || ! -L $gcc_src/mpfr || ! -L $gcc_src/mpc ]]; then
  (
    cd "$gcc_src"
    ./contrib/download_prerequisites --no-graphite
  )
fi

compiler_id=$($cc --version | sed -n '1p')
base_key=$(printf '%s\n' "$MAKE_SHA256" "$MUSL_SHA256" \
  "$BINUTILS_SHA256" "$compiler_id" 'static-x86_64-musl-v2-gnu17' | \
  sha256sum | cut -d' ' -f1)
gcc_key=$(printf '%s\n' "$GCC_SHA256" "$compiler_id" \
  'native-static-c-v1' | sha256sum | cut -d' ' -f1)
system_key=$(printf '%s\n' "$LINUX_SHA256" "$ZLIB_SHA256" \
  "$OPENSSL_SHA256" "$CURL_SHA256" "$GIT_SHA256" "$TAR_SHA256" \
  "$GZIP_SHA256" "$XZ_SHA256" "$BZIP2_SHA256" "$PATCH_SHA256" \
  "$FILE_SHA256" "$PKGCONF_SHA256" "$OPENSSH_SHA256" \
  "$CA_CERTIFICATES_SHA256" "$compiler_id" 'posix-system-v2-gnu17' | \
  sha256sum | cut -d' ' -f1)
stage_key=$(printf '%s\n' "$base_key" "$gcc_key" "$system_key" \
  'guest-vfs-layout-v7-relative-bzip2-links' | sha256sum | cut -d' ' -f1)

base_prefix="$build/$base_key"
musl_o="$base_prefix/musl"
musl_root="$base_prefix/musl-root"
make_o="$base_prefix/make"
make_root="$base_prefix/make-root"
binutils_o="$base_prefix/binutils"
binutils_root="$base_prefix/binutils-root"
gcc_prefix="$build/$gcc_key"
gcc_o="$gcc_prefix/gcc"
gcc_root="$gcc_prefix/gcc-root"
system_prefix="$build/$system_key"
linux_headers_o="$system_prefix/linux-headers"
linux_headers_root="$system_prefix/linux-headers-root"
zlib_o="$system_prefix/zlib"
zlib_root="$system_prefix/zlib-root"
openssl_o="$system_prefix/openssl"
openssl_root="$system_prefix/openssl-root"
pkgconf_o="$system_prefix/pkgconf"
pkgconf_root="$system_prefix/pkgconf-root"
curl_o="$system_prefix/curl"
curl_root="$system_prefix/curl-root"
git_o="$system_prefix/git"
git_root="$system_prefix/git-root"
tar_o="$system_prefix/tar"
tar_root="$system_prefix/tar-root"
gzip_o="$system_prefix/gzip"
gzip_root="$system_prefix/gzip-root"
xz_o="$system_prefix/xz"
xz_root="$system_prefix/xz-root"
bzip2_o="$system_prefix/bzip2"
bzip2_root="$system_prefix/bzip2-root"
patch_o="$system_prefix/patch"
patch_root="$system_prefix/patch-root"
file_o="$system_prefix/file"
file_root="$system_prefix/file-root"
openssh_o="$system_prefix/openssh"
openssh_root="$system_prefix/openssh-root"
stage="$build/$stage_key/stage"

if [[ ! -f $musl_root/.complete ]]; then
  mkdir -p "$musl_o" "$musl_root"
  (
    cd "$musl_o"
    CC="$cc" "$musl_src/configure" \
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
  mkdir -p "$binutils_o" "$binutils_root"
  for directory in binutils gas ld; do
    if [[ -f $binutils_o/$directory/Makefile ]]; then
      make -C "$binutils_o/$directory" clean
    fi
  done
  (
    cd "$binutils_o"
    CC="$cc" CXX="$cxx" CFLAGS='-O2 -static' \
      CXXFLAGS='-O2 -static' LDFLAGS='-static' \
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
  make -C "$binutils_o" MAKEINFO=true LDFLAGS=-static -j"$jobs" \
    all-binutils all-gas all-ld
  for directory in binutils gas ld; do
    make -C "$binutils_o/$directory" clean
    make -C "$binutils_o/$directory" MAKEINFO=true LDFLAGS=-all-static \
      -j"$jobs"
  done
  make -C "$binutils_o" MAKEINFO=true LDFLAGS=-static \
    DESTDIR="$binutils_root" \
    install-binutils install-gas install-ld
  printf '%s\n' "$binutils_recipe" > "$binutils_root/.complete"
fi

if [[ ! -f $gcc_root/.complete ]]; then
  mkdir -p "$gcc_o" "$gcc_root"
  (
    cd "$gcc_o"
    PATH="$binutils_root/usr/bin:$PATH" \
      CC="$cc" CXX="$cxx" CFLAGS='-O2' CXXFLAGS='-O2' \
      LDFLAGS='-static' "$gcc_src/configure" \
      --prefix=/usr --build="$target" --host="$target" --target="$target" \
      --enable-languages=c --disable-bootstrap --disable-multilib \
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
    CC="$cc" CFLAGS='-O2 -static' "$zlib_src/configure" \
      --prefix=/usr --static
  )
  make -C "$zlib_o" -j"$jobs"
  make -C "$zlib_o" DESTDIR="$zlib_root" install
  touch "$zlib_root/.complete"
fi

if [[ ! -f $openssl_root/.complete ]]; then
  mkdir -p "$openssl_o" "$openssl_root"
  (
    cd "$openssl_o"
    CC="$cc" AR="$ar" RANLIB="$ranlib" \
      "$openssl_src/Configure" linux-x86_64 \
      --prefix=/usr --libdir=lib --openssldir=/etc/ssl \
      no-shared no-tests no-module no-dso
  )
  make -C "$openssl_o" -j"$jobs"
  make -C "$openssl_o" DESTDIR="$openssl_root" install_sw
  touch "$openssl_root/.complete"
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
    CC="$cc" CFLAGS='-O2 -std=gnu17' LDFLAGS='-static' \
      "$pkgconf_src/configure" --prefix=/usr \
      --disable-shared --enable-static
  )
  make -C "$pkgconf_o" LDFLAGS=-all-static -j"$jobs"
  make -C "$pkgconf_o" LDFLAGS=-all-static \
    DESTDIR="$pkgconf_root" install
  printf '%s\n' "$pkgconf_recipe" > "$pkgconf_root/.complete"
fi

dependency_cpp="-I$openssl_root/usr/include -I$zlib_root/usr/include"
dependency_ld="-L$openssl_root/usr/lib -L$zlib_root/usr/lib"
dependency_pc="$openssl_root/usr/lib/pkgconfig:$zlib_root/usr/lib/pkgconfig"
curl_recipe='libtool-all-static-v1'

if [[ ! -f $curl_root/.complete ]] || \
   [[ $(<"$curl_root/.complete") != "$curl_recipe" ]]; then
  mkdir -p "$curl_o" "$curl_root"
  if [[ -f $curl_o/src/Makefile ]]; then
    make -C "$curl_o/src" clean
  fi
  (
    cd "$curl_o"
    CC="$cc" CFLAGS='-O2' CPPFLAGS="$dependency_cpp" \
      LDFLAGS="-static $dependency_ld" LIBS='-pthread' \
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
  make -C "$curl_o" -j"$jobs" CURL_LDFLAGS_BIN=-all-static
  make -C "$curl_o" DESTDIR="$curl_root" \
    CURL_LDFLAGS_BIN=-all-static install
  printf '%s\n' "$curl_recipe" > "$curl_root/.complete"
fi

if [[ ! -f $git_root/.complete ]]; then
  mkdir -p "$git_o" "$git_root"
  if [[ ! -f $git_o/Makefile ]]; then
    cp -a "$git_src"/. "$git_o"/
  fi
  git_flags=(
    "CC=$cc"
    "AR=$ar"
    "CFLAGS=-O2 $dependency_cpp -I$curl_root/usr/include"
    "LDFLAGS=-static $dependency_ld -L$curl_root/usr/lib"
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
  make -C "$git_o" -j"$jobs" "${git_flags[@]}" all
  make -C "$git_o" DESTDIR="$git_root" prefix=/usr \
    "${git_flags[@]}" install
  touch "$git_root/.complete"
fi

configure_make_install "$tar_src" "$tar_o" "$tar_root" --disable-nls
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
    CC="$cc" CFLAGS='-O2 -std=gnu17' LDFLAGS='-static' \
      "$xz_src/configure" --prefix=/usr \
      --disable-shared --enable-static --disable-nls --disable-doc
  )
  make -C "$xz_o" LDFLAGS=-all-static -j"$jobs"
  make -C "$xz_o" LDFLAGS=-all-static DESTDIR="$xz_root" install
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
    CFLAGS='-O2 -static -D_FILE_OFFSET_BITS=64'
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
    CC="$cc" CFLAGS='-O2 -std=gnu17' LDFLAGS='-static' \
      "$file_src/configure" --prefix=/usr \
      --disable-shared --enable-static --disable-libseccomp
  )
  make -C "$file_o" LDFLAGS=-all-static -j"$jobs"
  make -C "$file_o" LDFLAGS=-all-static DESTDIR="$file_root" install
  printf '%s\n' "$file_recipe" > "$file_root/.complete"
fi

if [[ ! -f $openssh_root/.complete ]]; then
  mkdir -p "$openssh_o" "$openssh_root/usr/bin"
  (
    cd "$openssh_o"
    CC="$cc" CFLAGS='-O2' CPPFLAGS="$dependency_cpp" \
      LDFLAGS="-static $dependency_ld" LIBS='-pthread' \
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
  touch "$openssh_root/.complete"
fi

if [[ ! -f $stage/.complete ]]; then
  mkdir -p "$stage"
  for root in \
      "$musl_root" "$linux_headers_root" "$make_root" "$binutils_root" \
      "$gcc_root" "$zlib_root" "$openssl_root" "$pkgconf_root" \
      "$curl_root" "$git_root" "$tar_root" "$gzip_root" "$xz_root" \
      "$bzip2_root" "$patch_root" "$file_root" "$openssh_root"; do
    cp -a "$root"/. "$stage"/
  done
  find "$stage" -name .complete -delete
  mkdir -p "$stage/etc/ssl/certs" "$stage/etc/ssh" \
    "$stage/usr/share/qm" "$stage/usr/bin"
  install -m 0644 "$ca_certificates" \
    "$stage/etc/ssl/certs/ca-certificates.crt"
  cp "$data/sources.env" "$stage/usr/share/qm/sources.env"
  ln -sfn certs/ca-certificates.crt "$stage/etc/ssl/cert.pem"
  ln -sfn pkgconf "$stage/usr/bin/pkg-config"
  ln -sfn gcc "$stage/usr/bin/cc"
  rm -f "$stage/usr/bin/openssl" "$stage/usr/bin/c_rehash"
  rm -rf "$stage/usr/share/doc" "$stage/usr/share/info" \
    "$stage/usr/share/locale" "$stage/usr/share/man"
  absolute_link=$(find "$stage" -type l -lname '/*' -print -quit)
  if [[ -n $absolute_link ]]; then
    printf 'staged system has a host-absolute symlink: %s -> %s\n' \
      "$absolute_link" "$(readlink "$absolute_link")" >&2
    exit 1
  fi
  touch "$stage/.complete"
fi

smoke="$build/$stage_key/smoke"
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

artifact="$out/x86_64-linux-musl-system-$stage_key.tar"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 \
  --numeric-owner -C "$stage" --exclude=.complete \
  -cf "$artifact.tmp" .
mv "$artifact.tmp" "$artifact"
sha256sum "$artifact" > "$artifact.sha256"
printf '%s\n' "$artifact"
