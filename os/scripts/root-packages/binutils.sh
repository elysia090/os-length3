# binutils, as the base built it: as, ld and the binary tools, each all-static (libtool reads -static as "prefer
# static libraries", so the programs are linked again with -all-static), without gold, gdb or gprofng.
pins="BINUTILS"
tools="bison flex perl texinfo"
build() {
  mkdir ../o && cd ../o
  CFLAGS="$c17 -static" CXXFLAGS='-O2 -static' LDFLAGS='-static' MAKEINFO=true \
    ../src/configure --prefix=/usr --build="$target" --host="$target" --target="$target" \
      --disable-gold --disable-gdb --disable-gdbserver --disable-gprofng --disable-libdecnumber --disable-nls \
      --disable-readline --disable-shared --disable-sim --disable-werror --enable-static --without-babeltrace \
      --without-debuginfod --without-zstd
  make MAKEINFO=true LDFLAGS='-static' -j"$jobs" all-binutils all-gas all-ld
  for d in binutils gas ld; do
    make -C "$d" clean
    make -C "$d" MAKEINFO=true LDFLAGS='-all-static' -j"$jobs"
  done
  make MAKEINFO=true LDFLAGS='-static' DESTDIR="$dest" install-binutils install-gas install-ld
}
