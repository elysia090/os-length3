#!/bin/sh
# Only this opt-in fixture uses the staged upstream sources. No download occurs here.
set -eu
[ "$#" -eq 3 ] || { echo "usage: $0 scanner|guest SOURCE_ROOT BUILD_ROOT" >&2; exit 2; }
mode=$1 sources=$(cd "$2" && pwd) build=$3
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
wl="$sources/wayland" ffi="$sources/libffi" proto="$sources/wayland-protocols"
export LC_ALL=C SOURCE_DATE_EPOCH=0
# Contents, not just a tag, are verified before any compile or generator.
(cd "$sources" && sha256sum -c "$here/sources.sha256")
mkdir -p "$build"
build=$(cd "$build" && pwd)
if [ "$mode" = scanner ]; then
  mkdir -p "$build/generated"
  sed -e 's/@WAYLAND_VERSION_MAJOR@/1/g' -e 's/@WAYLAND_VERSION_MINOR@/25/g' \
      -e 's/@WAYLAND_VERSION_MICRO@/0/g' -e 's/@WAYLAND_VERSION@/1.25.0/g' \
      "$wl/src/wayland-version.h.in" > "$build/wayland-version.h"
  # The host libexpat is only for the scanner; no host-object files are linked into the guest.
  # Compiler flag expansion below is for pkg-config's whitespace-separated argument list.
  "${HOST_CC:-cc}" -std=gnu11 -D_GNU_SOURCE -DHAVE_LIBXML=0 -O2 \
    -I"$build" -I"$wl/src" "$wl/src/scanner.c" "$wl/src/wayland-util.c" \
    $(pkg-config --cflags --libs expat) -o "$build/wayland-scanner"
  gen() { "$build/wayland-scanner" "$1" "$2" "$build/generated/$3"; }
  gen client-header "$wl/protocol/wayland.xml" wayland-client-protocol.h
  "$build/wayland-scanner" -c client-header "$wl/protocol/wayland.xml" "$build/generated/wayland-client-protocol-core.h"
  gen server-header "$wl/protocol/wayland.xml" wayland-server-protocol.h
  gen private-code "$wl/protocol/wayland.xml" wayland-protocol.c
  gen client-header "$proto/stable/xdg-shell/xdg-shell.xml" xdg-client.h
  gen server-header "$proto/stable/xdg-shell/xdg-shell.xml" xdg-server.h
  gen private-code "$proto/stable/xdg-shell/xdg-shell.xml" xdg-protocol.c
  (cd "$build" && sha256sum -c "$here/generated.sha256")
  exit 0
fi
[ "$mode" = guest ] || { echo "unknown build stage: $mode" >&2; exit 2; }
(cd "$build" && sha256sum -c "$here/generated.sha256")
cc=${CC:-musl-gcc} ar=${AR:-ar}
mkdir -p "$build/ffi" "$build/obj" "$build/uapi"
uapi=${EVERYDAY_LINUX_UAPI:-/usr/include}
# Expose only the Linux kernel UAPI to the musl build, not host libc/headers.
for dir in linux asm-generic; do
  test -d "$uapi/$dir"
  ln -sfn "$uapi/$dir" "$build/uapi/$dir"
done
asm="$uapi/asm"; if [ ! -d "$asm" ]; then asm="$uapi/x86_64-linux-gnu/asm"; fi
test -d "$asm"; ln -sfn "$asm" "$build/uapi/asm"
cp "$here/libffi-config.h" "$build/ffi/fficonfig.h"
cp "$ffi/src/x86/ffitarget.h" "$build/ffi/"
cp "$here/wayland-config.h" "$build/config.h"
sed -e 's/@VERSION@/3.5.2/g' -e 's/@TARGET@/X86_64/g' -e 's/@HAVE_LONG_DOUBLE@/1/g' \
    -e 's/@FFI_VERSION_STRING@/3.5.2/g' -e 's/@FFI_VERSION_NUMBER@/30502/g' \
    -e 's/@FFI_EXEC_TRAMPOLINE_TABLE@/0/g' "$ffi/include/ffi.h.in" > "$build/ffi/ffi.h"
! grep -Eq '@[A-Z_]+@' "$build/ffi/ffi.h"
for unit in prep_cif.c types.c closures.c tramp.c raw_api.c java_raw_api.c x86/ffi64.c x86/ffiw64.c x86/unix64.S x86/win64.S; do
  unit_name=${unit##*/}; obj="$build/obj/ffi-${unit_name%.*}.o"
  "$cc" -D_GNU_SOURCE -O2 -fPIC -fstack-protector-strong -I"$build/ffi" -isystem "$build/uapi" \
    -I"$ffi/include" -I"$ffi/src/x86" -c "$ffi/src/$unit" -o "$obj"
done
"$ar" crD "$build/libffi.a" "$build/obj"/ffi-*.o
for unit in connection wayland-util wayland-os wayland-client wayland-server event-loop wayland-shm; do
  "$cc" -std=gnu11 -D_GNU_SOURCE -O2 -fPIC -fstack-protector-strong -I"$build" -I"$build/ffi" \
    -I"$build/generated" -I"$wl/src" -c "$wl/src/$unit.c" -o "$build/obj/wl-$unit.o"
done
"$cc" -std=gnu11 -O2 -fPIC -fstack-protector-strong -I"$wl/src" \
  -c "$build/generated/wayland-protocol.c" -o "$build/obj/wl-protocol.o"
"$ar" crD "$build/libwayland.a" "$build/obj"/wl-*.o
fixture() {
  binary=$1; shift
  "$cc" -std=gnu11 -D_GNU_SOURCE -O2 -Wall -Wextra -Werror -fstack-protector-strong \
    -static -no-pie -Wl,-z,relro,-z,now,-z,noexecstack -I"$build" -I"$wl/src" -I"$build/generated" \
    "$@" "$build/generated/xdg-protocol.c" "$build/libwayland.a" "$build/libffi.a" -pthread -o "$build/$binary"
  readelf -hW -lW -dW "$build/$binary" > "$build/$binary.elf.log"
  grep -q 'Type:.*EXEC' "$build/$binary.elf.log"
  ! grep -Eq 'INTERP|NEEDED|RPATH|RUNPATH' "$build/$binary.elf.log"
  grep -Eq 'GNU_STACK.* RW ' "$build/$binary.elf.log"
}
fixture wayland-presenter "$here/start.c" "$here/client.c" "$here/server.c"
fixture wayland-socket-client "$here/socket-client.c" "$here/client.c"
