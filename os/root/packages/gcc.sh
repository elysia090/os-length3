# GCC, C, with GMP, MPFR and MPC built inside it (cc1 links them statically), its libgcc built by the GCC just made,
# and `cc`, the name make and every build reaches for, with POSIX's c99 and c89. What the build machine's compiler
# builds of it is C17; libgcc is built by the new GCC for its own default, so it is given only -O2. Its own programs
# are position-independent and bound at once (host PIE, BIND_NOW), as the root's others are: GCC makes them neither
# unless told. And what it makes is what the root's own programs are, unless asked otherwise (-static, -shared, -r,
# -nostdlib, -nostartfiles, or each flag's own no-): a static PIE (musl's rcrt1.o; the root has no dynamic loader),
# with the stack protector, stack clash protection, CET and full RELRO; so a program built here runs wherever the
# root runs, a browser's Prompt among them.
pins="GCC GMP MPFR MPC"
tools="bison flex perl texinfo"
build() {
  for p in GMP MPFR MPC; do unpack "$p" "$PWD/$(echo "$p" | tr 'A-Z' 'a-z')"; done
  mkdir ../o && cd ../o
  CFLAGS_FOR_TARGET='-O2' CXXFLAGS_FOR_TARGET='-O2' \
    ../src/configure --prefix=/usr --build="$target" --host="$target" --target="$target" \
      --enable-languages=c --disable-lto --disable-bootstrap --disable-multilib --disable-nls --disable-shared \
      --enable-host-pie --enable-host-bind-now --enable-default-pie --enable-default-ssp \
      --with-specs='%{!shared:%{!static:%{!static-pie:%{!r:%{!nostdlib:%{!nostartfiles:-static-pie}}}}}} %{!fno-stack-clash-protection:-fstack-clash-protection} %{!fcf-protection*:-fcf-protection} %{!shared:%{!r:-Wl,-z,relro -Wl,-z,now -Wl,-z,noexecstack}}' \
      --enable-static --disable-libatomic --disable-libgomp --disable-libquadmath --disable-libsanitizer \
      --disable-libssp --disable-libstdcxx-pch --disable-libvtv --without-isl --without-zstd --with-sysroot=/ \
      --with-native-system-header-dir=/usr/include
  make -j"$jobs" all-gcc all-target-libgcc
  make DESTDIR="$dest" install-gcc install-target-libgcc
  ln -sf gcc "$dest/usr/bin/cc"
  # POSIX's c99 (and c89, which configure scripts still look for): the C compiler held to that standard.
  for s in 99 89; do printf '#!/bin/sh\nexec gcc -std=c%s "$@"\n' "$s" > "$dest/usr/bin/c$s"; chmod 0755 "$dest/usr/bin/c$s"; done
}
check() {
  # It compiles C as C says: floating literals as written (the base's post-linked cc1 made `7.3 * 12` 57).
  printf '%s\n' '#include <stdio.h>' 'int main(void) { double f[] = {6.5, 7.3, 0.1}; int i = 7.3 * 12;' \
    '  printf("%.17g %.17g %.17g %d\n", f[0], f[1], f[2], i); return 0; }' > literals.c
  "$dest/usr/bin/gcc" -B"$dest/usr/libexec/gcc/$target/$GCC_VERSION/" -B"$dest/usr/lib/gcc/$target/$GCC_VERSION/" \
    -O1 -o literals literals.c
  [ "$(./literals)" = '6.5 7.2999999999999998 0.10000000000000001 87' ]
  # Made, unasked, as the root's own programs are: a static PIE (no interpreter), bound at once, and a buffer whose
  # address leaves its function guarded by a canary.
  printf '%s\n' '#include <stdio.h>' '#include <string.h>' \
    'int main(int argc, char **argv) { char b[64]; snprintf(b, sizeof b, "%s", argv[0]); return argc > 1 && !*b; }' > guard.c
  "$dest/usr/bin/gcc" -B"$dest/usr/libexec/gcc/$target/$GCC_VERSION/" -B"$dest/usr/lib/gcc/$target/$GCC_VERSION/" \
    -O2 -o guard guard.c
  ./guard
  h=$(readelf -hld guard)
  echo "$h" | grep -q 'Type: *DYN'
  echo "$h" | not grep -q INTERP
  echo "$h" | grep -qE 'BIND_NOW|FLAGS_1.*NOW'
  nm guard | grep -q ' __stack_chk_fail$'
}
