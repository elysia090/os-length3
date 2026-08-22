# Reproducible x86 Linux input

`artifact/linux-x86-64` is generated only from the upstream inputs locked in
`sources.env`. Local WSL kernels and `qm-linux-spike` are diagnostic references,
not artifact inputs.

The current source roles are:

- Linux 7.1.8, the stable release published by kernel.org on 2026-08-09.
- BusyBox 1.37.0, the versioned upstream release used by the current boot
  artifact.  BusyBox labels this series unstable; the source and checksum are
  nevertheless fixed here rather than following a snapshot.
- musl 1.2.6, GNU make 4.4.1, GNU Binutils 2.46 and GCC 16.2.0, plus the pinned POSIX build,
  archive, HTTPS, Git and OpenSSH-client sources consumed by
  `toolchain/build.sh`. They form a separate read-only system layer and are
  not inflated into the initramfs. `bootstrap/Makefile` is a deterministic
  parallel-process smoke test, and the initramfs provides a mode-1777 `/tmp`
  for GNU make's FIFO jobserver.

`build.sh` downloads two HTTPS tarballs, verifies their pinned SHA-256 values,
builds a deliberately small legacy-PIC x86-64 kernel with the standard
IPv4/IPv6 and virtio-net/MMIO path enabled, builds static BusyBox,
creates a deterministic `newc` initramfs, and publishes a new canonical boot
object plus its page delivery. No browser-side socket or TCP implementation is
part of this input.

Run it in NixOS/WSL with the ordinary kernel build tools available. The script
resolves the static BusyBox compiler from `pkgsMusl.gcc` and the host-only
libelf headers from `elfutils.dev`; neither becomes a runtime input:

```sh
cd data
nix shell \
  nixpkgs#gnumake nixpkgs#gcc15 nixpkgs#binutils \
  nixpkgs#flex nixpkgs#bison nixpkgs#bc \
  nixpkgs#cpio nixpkgs#xz nixpkgs#perl nixpkgs#rsync nixpkgs#pkg-config \
  nixpkgs#openssl nixpkgs#elfutils nixpkgs#pahole nixpkgs#squashfsTools \
  -c env QM_BUILD_ROOT=/tmp/libqm-linux-build \
    QM_TOOLCHAIN_TAR=/tmp/libqm-toolchain-system-output/x86_64-linux-musl-system-<identity>.tar \
    ./build.sh
```

`QM_BUILD_ROOT` deliberately keeps the disposable expansion on WSL's native
filesystem instead of importing any WSL kernel. Its default is
`$TMPDIR/libqm-linux-build`; `QM_OUTPUT_ROOT` likewise defaults to
`$TMPDIR/libqm-linux-output`. Checked-in `data/` contains only the upstream
source lock, configuration fragments, resolved exact `.config` locks, `/init`,
small bootstrap inputs, and the reproduction procedure. A successful build
promotes only the canonical immutable projection to `artifact/`. `build.sh`
refuses to publish when a resolved config differs from its versioned lock.

Kernel selftests are verification inputs, never boot-artifact contents. The
`x86`, `signal`, `futex`, `clone3`, `exec`, `timers`, `ptrace`, `pipe/IPC`,
`mm`, `tty`, `seccomp`, and `net` suites stay below `data/` (or a verified
upstream source cache), execute against a disposable runtime overlay, and do
not change the identity of the minimal kernel + BusyBox artifact.

The pinned development-only x86 semantic references live under
[`oracle/`](oracle/README.md). They certify the post-link compiler but are not
Linux, toolchain or browser artifact inputs.

Update policy:

1. Read `https://www.kernel.org/releases.json` and select `latest_stable`.
2. Use a BusyBox release explicitly labelled stable by busybox.net.
3. Update URLs and digests in `sources.env` together.
4. Regenerate and review the versioned exact `.config` locks.
5. Build and verify `/init`, the BusyBox prompt, `make -j8 -f
   /opt/qm/Makefile`, `uname -a`, and `ls /` in the real browser before
   publishing the artifact.

`toolchain/build.sh` independently builds the pinned musl sysroot, matching
Linux UAPI headers, native C toolchain, archive utilities, pkgconf, file,
OpenSSL/CA/curl/Git and OpenSSH clients into a deterministic archive. The boot
build projects that archive into a 64 KiB-block read-only SquashFS image at a
reserved physical address. Upstream Linux exposes the range through `phram`,
mounts `/dev/mtdblock0`, and binds its `/usr` and `/etc/ssl` into the initial
namespace. Keeping it separate from the initramfs preserves demand paging:
compiler code, headers, static libraries and trust anchors remain cold until
Linux opens them. The current `artifact/compiler` remains the smaller
WebAssembly-only frontend and is not replaced by guest-native GCC.
