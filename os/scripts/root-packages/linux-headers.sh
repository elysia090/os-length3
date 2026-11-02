# Linux's headers for programs (linux/, asm/ and the rest the kernel exports), at the kernel this tree pins.
pins="LINUX"
tools="rsync perl"
build() {
  make ARCH=x86_64 INSTALL_HDR_PATH="$dest/usr" headers_install
}
