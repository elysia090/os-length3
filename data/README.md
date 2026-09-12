# Reproducible x86 Linux input

`artifact/linux-x86-64` is generated only from the upstream inputs locked in
`sources.env`. Local WSL kernels and `qm-linux-spike` are diagnostic references,
not artifact inputs.

The current source roles are:

- Linux 7.1.8, the stable release published by kernel.org on 2026-08-09.
- BusyBox 1.37.0, the versioned upstream release used by the current boot
  artifact.  BusyBox labels this series unstable; the source and checksum are
  nevertheless fixed here rather than following a snapshot.
- musl 1.2.6, GNU make 4.4.1, GNU Binutils 2.46 and GCC 16.2.0, plus the pinned
  POSIX build, archive, HTTPS, Git and OpenSSH-client sources consumed by
  `toolchain/build.sh`;
- apk-tools, dhcpcd, libmnl/libnftnl/nftables, chrony, e2fsprogs, shadow,
  libxcrypt, libcap, acl, attr, zstd, ncurses, nano and tzdata consumed by
  `distribution/build-system-tools.sh`.

Together these form the standard read-only system layer and are not inflated
into the initramfs. `bootstrap/Makefile` is a deterministic parallel-process
smoke test, and the initramfs provides a mode-1777 `/tmp` for GNU make's FIFO
jobserver.

`build.sh` verifies every source used by its kernel, BusyBox, service,
administration and toolchain subrecipes, builds a deliberately small
legacy-PIC x86-64 kernel with the standard IPv4/IPv6 and virtio-net/MMIO path
enabled, and creates a deterministic `newc` rescue initramfs. Every ordinary
linked x86 executable in the release root is replaced by its independently
proved optimized ELF before the complete profile gate runs. The gate checks
the exact command-provider path, service/runtime closure, resource set and
embedded source/profile locks. It does not call an old Python publisher or
treat a tar/SquashFS image as canonical identity. Until the C Artifact
publisher is connected, the recipe terminates after reporting the verified
input set rather than claiming a published release. No browser-side socket or
TCP implementation is part of this input.

The same gate runs `artifact-measure-root` over the complete candidate root.
Its v4 report opens every GNU archive into member/symbol views, proves exact
member-payload identity across archives, and regenerates every canonical
archive byte. Valid noncanonical upstream streams are measured separately as
rewrite input; the final release gate requires that count to be zero.
The remaining all-file number is only a strict 4 KiB-page upper bound: SHA-256 selects possible
matches, then the complete extent bytes are compared before two pages share an
owner.  Its executable/read-only/archive partitions identify the next linear
terms, but neither a page count nor its digest can stand in for the canonical
whole-word publisher.

Component checkpoints retain ordinary relocation-bearing linked roots and an
explicit package owner for every path. They never invoke
`distribution/optimize-payload.sh`: doing so would erase construction
relocations before the publication schedule is known. `build.sh` opens every
package root in one release-wide schedule, then returns each independently
runnable optimized ELF to the package and path that owned its linked input.
Hardlink aliases are restored inside that owner domain after atomic
replacement. Its report records the required `0x3f`. The stage opens the
authoritative input namespace and orders ELF, archive and ordinary payload
owners by generated per-family content ordinal before compiling or sharing.
It preserves opened/retained semantic bytes,
complete-future classes, unique final-ELF fragments, retained program
material, archive member/view material, nonempty ordinary immutable inode
payloads, stored factor bits/bytes, zero
optimality gap, and construction workspace as separate quantities.
`distribution/check-optimize-payload.sh` is the small fixed regression for the
one-process boundary and proves that an already optimized ELF cannot re-enter
the compiler. Canonical publication remains red until this one process is run
over the complete release root and kernel and its resulting word is projected
through Storage. The filesystem population itself is no longer an omitted
adjacent gate.

`artifact-measure-namespace` now opens that missing filesystem population with
the same C normal form used by the complete gate. On the fixed candidate root,
6,210 paths / 4,860 inodes contain 188,821 bytes of repeated complete path
spelling. Component preorder retains 55,498 basename bytes, a 12,418-bit tree
and 1,350 sparse hardlink aliases. All topology/inode/link material is 207,254
opened bytes, 72,889 exact unique bytes and 446,441 stored factor bits (55,806
bytes), with a zero factor gap. The production wrapper now joins that material
to its ELF/archive/VFS word in the same version-9 C transaction. The same
transaction stores one packed, minimally wide column table for the
complete-future quotient instead of one fixed-width tuple per class. The
standalone number remains useful only as an upper bound; it is not published
as a second sidecar.

Run it in NixOS/WSL. `build.sh` re-enters the checked-in
`bootstrap/flake.lock`
automatically, so the host compiler and build-tool population cannot follow an
ambient `nixpkgs` registry or `PATH`. The static BusyBox compiler and host-only
libelf headers are resolved from that same lock; neither becomes a runtime
payload, but the bootstrap lock digest is part of release provenance:

```sh
cd data
QM_BUILD_ROOT=/tmp/libqm-linux-build \
QM_TOOLCHAIN_PACKAGE_SET=/mnt/c/.../temp/toolchain-output/x86_64-linux-musl-toolchain-<identity>.packages \
  ./build.sh
```

`QM_BUILD_ROOT` deliberately keeps the disposable expansion on WSL's native
filesystem instead of importing any WSL kernel. Its default is
`$TMPDIR/libqm-linux-build`; `QM_OUTPUT_ROOT` likewise defaults to
`$TMPDIR/libqm-linux-output`. Checked-in `data/` contains only the upstream
source lock, configuration fragments, resolved exact `.config` locks, `/init`,
small bootstrap inputs, and the reproduction procedure. A future successful
Artifact publication may promote only the canonical immutable projection to
`artifact/`; the current build stops before that boundary. `build.sh` refuses
to publish when a resolved config differs from its versioned lock.

To measure linked-x86 closure without rebuilding the distribution, reconstruct
only the uncompressed linker result from the same source digest and resolved
configuration lock:

```sh
cd data
QM_LINKED_KERNEL_ROOT=/tmp/libqm-linked-kernel-7.1.8 \
  ./build-linked-kernel.sh
```

`build-linked-kernel.sh` selects Kbuild's standard
`CONFIG_ARCH_VMLINUX_NEEDS_RELOCS` link path and reports its
`vmlinux.unstripped` from that disposable root. It does not construct a second
kernel recipe, package payload or Artifact: the source digest and exact
resolved `.config` remain the same checked-in authorities used by `build.sh`.
The output exists solely to make whole-linked-image closure a repeatable
compiler gate. The standard x86 linker policy therefore retains its 2 MiB
`PT_LOAD` alignment while the construction ELF retains static relocations.
Those relocation sections are compiler input only; the optimized ELF rewrites
the affected fields and does not store them.

Kernel selftests are verification inputs, never boot-artifact contents. The
`x86`, `signal`, `futex`, `clone3`, `exec`, `timers`, `ptrace`, `pipe/IPC`,
`mm`, `tty`, `seccomp`, and `net` suites stay below `data/` (or a verified
upstream source cache), execute against a disposable runtime overlay, and do
not change the identity of the minimal kernel + BusyBox artifact.

The pinned development-only x86 semantic references and their separate source
lock live under [`oracle/`](oracle/README.md). They certify the post-link
compiler but are not Linux, toolchain or browser Artifact inputs.

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
OpenSSL/CA/curl/Git and OpenSSH clients as relocation-bearing pre-package
payloads. Its output is a build-only package-root set, not a merged archive,
installed root, or optimized publication. The release-selected schedule
post-link compiles and independently verifies each owner's ELFs before those
exact bytes are eligible for `.apk` creation and signing. The signed apk gate
is not implied by the package-root checkpoint: it separately signs every
package and index, installs the exact offline world, and audits the resulting
ownership database. The Artifact writer remains red. The final path projects
the authenticated apk-installed root into a demand-paged read-only filesystem at a reserved
physical address. Upstream Linux owns that mount and its VFS semantics.
Compiler code, headers, static libraries and trust anchors remain cold until
Linux opens them. The primary 75 MB (75,000,000-byte) gate applies to the canonical program
word emitted from the kernel/boot/root semantics; Storage reports compressed
transfer bytes later and separately. The current
`artifact/compiler` remains the smaller WebAssembly-only frontend and is not
replaced by guest-native GCC.

`distribution/build-system-tools.sh` assembles that verified linked-toolchain
package set only as a disposable dependency sysroot, builds every remaining standard-profile provider
from the official locked source, checkpoints each package independently and
removes build-only files from the runtime projection. `build.sh` merges the
boot, init, toolchain, core-tools and system-tools roots only for analysis and
closure measurement. That union is not a package or release. The product path
must return every optimized ELF to its original
package root, create and sign apk v3 packages and their index, install the exact
world into a private candidate, and pass
`distribution/check-package-publication.sh` before Artifact publication. This
signed apk transaction is now the only product-root constructor; the raw union
remains a build-only analysis checkpoint. Artifact publication is the remaining
red boundary. `distribution/check-root.sh` proves payload closure but cannot by
itself call a raw package union a release. The normative metadata, dependency, ownership,
script/trigger, and transaction policy is
[`../src/v2/docs/PACKAGE.md`](../src/v2/docs/PACKAGE.md).
