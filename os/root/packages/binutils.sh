# binutils: as, ld and the binary tools, without gold, gdb or gprofng. libtool links its programs dynamically under
# -static, so each is linked again at make time with -all-static.
pins="BINUTILS"
tools="bison flex perl texinfo"
build() {
  mkdir ../o && cd ../o
  MAKEINFO=true ../src/configure --prefix=/usr --build="$target" --host="$target" --target="$target" \
    --disable-gold --disable-gdb --disable-gdbserver --disable-gprofng --disable-libdecnumber --disable-nls \
    --disable-readline --disable-shared --disable-sim --disable-werror --enable-static --without-babeltrace \
    --without-debuginfod --without-zstd
  make MAKEINFO=true -j"$jobs" all-binutils all-gas all-ld
  for d in binutils gas ld; do
    make -C "$d" clean
    make -C "$d" MAKEINFO=true LDFLAGS="$allstatic" -j"$jobs"
  done
  make MAKEINFO=true DESTDIR="$dest" install-binutils install-gas install-ld
}
check() {
  # The assembler and linker made, driven by the build machine's compiler: a program they make runs. (That compiler
  # would have the linker load its LTO plugin, a shared object, which a static ld does not load; the root's own GCC
  # is built without LTO.)
  printf 'int main(void) { return 42; }\n' > t.c
  gcc -fno-use-linker-plugin -B"$dest/usr/bin/" -static -o t t.c
  ./t || [ $? = 42 ]
}
