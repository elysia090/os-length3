# GCC, C, as the base built it, with GMP, MPFR and MPC built inside it (so cc1 links them statically), its libgcc
# built by the GCC just made; and `cc`, the name make and every build reaches for. It is right before it is given:
# a program with floating literals, built with it, says what C says (the base's, post-linked, said `7.3 * 12` is 57).
pins="GCC GMP MPFR MPC"
tools="bison flex perl texinfo"
build() {
  for p in GMP MPFR MPC; do unpack "$p" "$PWD/$(echo "$p" | tr 'A-Z' 'a-z')"; done
  mkdir ../o && cd ../o
  # What the host compiler builds is C17; what the GCC made builds (libgcc) is GCC's own and C23, its default.
  CFLAGS="$c17" CXXFLAGS='-O2' LDFLAGS='-static' CFLAGS_FOR_TARGET='-O2' CXXFLAGS_FOR_TARGET='-O2' \
    ../src/configure --prefix=/usr --build="$target" --host="$target" --target="$target" \
      --enable-languages=c --disable-lto --disable-bootstrap --disable-multilib --disable-nls --disable-shared \
      --enable-static --disable-libatomic --disable-libgomp --disable-libquadmath --disable-libsanitizer \
      --disable-libssp --disable-libstdcxx-pch --disable-libvtv --without-isl --without-zstd --with-sysroot=/ \
      --with-native-system-header-dir=/usr/include
  make -j"$jobs" all-gcc all-target-libgcc
  make DESTDIR="$dest" install-gcc install-target-libgcc
  ln -sf gcc "$dest/usr/bin/cc"
  rm -rf "$dest/usr/lib/gcc/$target/$GCC_VERSION/plugin"
  printf '%s\n' '#include <stdio.h>' 'int main(void) { double f[] = {6.5, 7.3, 0.1}; int i = 7.3 * 12;' \
    '  printf("%.17g %.17g %.17g %d\n", f[0], f[1], f[2], i); return 0; }' > literals.c
  "$dest/usr/bin/gcc" -B"$dest/usr/libexec/gcc/$target/$GCC_VERSION/" -O1 -o literals literals.c
  said=$(./literals)
  [ "$said" = '6.5 7.2999999999999998 0.10000000000000001 87' ] || { echo "the GCC made compiles literals wrong: $said"; exit 1; }
}
