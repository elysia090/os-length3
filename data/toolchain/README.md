# Reproducible native Linux system layer

`build.sh` produces one deterministic, static x86-64 musl archive.  It is the
read-only `/` system layer visible as soon as Linux reaches its shell; its
physical pages remain non-resident until a process opens them.

The layer contains:

- musl libc headers, startup objects and static libraries;
- Linux UAPI headers from the exact kernel source lock;
- GCC, GNU binutils and GNU make;
- pkgconf, file/libmagic and GNU patch;
- GNU tar and gzip, XZ Utils and bzip2;
- zlib, OpenSSL, curl and Git with HTTPS enabled;
- the OpenSSH clients (`ssh`, `scp`, `sftp` and key/agent tools);
- a pinned Mozilla CA bundle at `/etc/ssl/certs/ca-certificates.crt`.

BusyBox supplies the small POSIX shell and ordinary core utilities in the boot
root.  This archive supplies the full development and network surface without
putting cold compiler, headers or certificate pages in the boot working set.
Selftests, LTP and libc tests are disposable inputs and are deliberately not in
this system layer.

Every upstream URL and SHA-256 digest is fixed in `../sources.env`.  Downloaded
official archives are cached in `../upstream`; expansion, compilation and the
canonical tar are kept under the operating-system temporary directory by
default.  The source lock is also installed as `/usr/share/qm/sources.env` so a
running guest can identify the inputs that produced its immutable layer.

The browser compiler remains a separate WebAssembly frontend.  Native GCC and
the utilities execute as x86 guest programs, so their decoded blocks enter the
same SSA, QM and physical-codec path as the kernel instead of adding a host-side
execution route.

Example:

```sh
cd data/toolchain
nix shell \
  nixpkgs#gnumake nixpkgs#gcc nixpkgs#perl nixpkgs#texinfo \
  nixpkgs#xz nixpkgs#bzip2 nixpkgs#curl nixpkgs#rsync \
  nixpkgs#coreutils nixpkgs#gnused nixpkgs#gawk nixpkgs#findutils \
  nixpkgs#diffutils nixpkgs#which \
  -c env QM_TOOLCHAIN_BUILD_ROOT=/tmp/libqm-toolchain-system-build \
    QM_OUTPUT_ROOT=/tmp/libqm-toolchain-system-output bash ./build.sh
```

The build compiles and runs `smoke.c` with the staged GCC/sysroot, rejects a
dynamic interpreter on the principal tools, checks all required VFS paths, and
prints the completed tar path.  Publish that one canonical object as the
demand-paged system projection:

```sh
uv run --no-project python ../../src/v2/tools/build_toolchain_distribution.py \
  /tmp/libqm-toolchain-system-output/x86_64-linux-musl-system-<identity>.tar \
  --out ../../artifact --name toolchain --version 2026.08.13
```
