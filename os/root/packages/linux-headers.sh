# Linux's headers for programs (linux/, asm/ and the rest the kernel exports), at the kernel this tree pins.
pins="LINUX"
tools="rsync perl"
build() {
  make ARCH=x86_64 INSTALL_HDR_PATH="$dest/usr" headers_install
}
check() {
  printf '#include <linux/openat2.h>\n#include <linux/version.h>\nint main(void) { struct open_how h = {0}; return (int)h.flags; }\n' > t.c
  gcc -nostdinc -isystem "$dest/usr/include" -isystem /usr/include -isystem "$(gcc -print-file-name=include)" -fsyntax-only t.c
}
