# Reproducible x86 Linux input

The native release bundle (see [Native Release assets](#native-release-assets))
is generated only from the upstream inputs locked in `sources.env`. NixOS, WSL
kernels and their temporary build trees are not used.

The current source roles are:

- Linux 7.3, kernel.org's latest stable release when it was pinned.
- BusyBox 1.36.1, the latest release explicitly labelled stable by BusyBox.
  The newer 1.37.x and 1.38.x series are labelled unstable upstream.
- musl 1.2.6, GNU make 4.4.1, GNU Binutils 2.46.1 and GCC 16.2.0, plus the pinned
  POSIX build, archive, HTTPS, Git and OpenSSH-client sources consumed by
  `toolchain/build.sh`;
- apk-tools, dhcpcd, libmnl/libnftnl/nftables, chrony, e2fsprogs, shadow,
  libxcrypt, libcap, acl, attr, zstd, ncurses, nano and tzdata consumed by
  `packaging/build-system-tools.sh`.

Each is its newest release by the rule `sources-next.py` writes beside it;
`.github/workflows/sources-next.yml` says every week which have a newer one
(with the digests to pin it by) and checks that every other pin is still
the file its maker serves.

The util-linux 2.42.4 source needs the narrow, checked-in
[`openat2` include patch](patches/util-linux-2.42.4-openat2.patch) to build
its idmapped-mount hook against the locked Linux headers. Its digest is part
of the core-tools component key; the Linux UAPI supplies the flag value.

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
treat a tar/SquashFS image as canonical identity. After the verified installed
root exists, it publishes a deterministic native `.tar.zst` bundle containing
that root and its boot files. This is a runnable native download, not a claim
that the later canonical Artifact release word or browser projection is built.
No browser-side socket or TCP implementation is part of this input.

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
`packaging/optimize-payload.sh`: doing so would erase construction
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
`packaging/check-optimize-payload.sh` is the small fixed regression for the
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

Run inside the independent Linux build host described in `bootstrap/README.md`.
Its differential disk lives in Windows `temp/bootstrap/`, with no NixOS or WSL
dependency. Each build entry checks the exact `bootstrap/installed.lock`
population and uses the fixed compiler/tool paths. The signed package inputs
are retained under `upstream/bootstrap/packages/`; their digests and installed
population are part of release provenance, not runtime binary payloads:

```sh
cd distribution
QM_BUILD_ROOT=/build/source/temp/release-build \
QM_OUTPUT_ROOT=/build/source/temp/release-output \
QM_TOOLCHAIN_PACKAGE_SET=/absolute/path/to/verified-toolchain.packages \
QM_APK_SIGNING_KEY=/secure/release.private.pem \
QM_APK_PUBLIC_KEY=/secure/release.public.pem \
  ./build.sh
```

The signing key is an external release input, never a file from this source
tree. Before publishing, the build enters the candidate root in a private
mount namespace and requires C compile/run, `make`, `file`, Git repository
creation/status, `apk info musl`, `curl`, and `ssh -V` to succeed. The signed
package index is present at the installed repository coordinate; only
scratch `/tmp` and a separate writable `/root` project home are writable for
this smoke test. It then extracts the exact downloadable `.tar.zst`, checks
its manifest and installed-root closure, and repeats the native smoke and an
upstream zlib `configure`/`make`/`test`/`install` workflow from that extracted
root. On success the script prints
`native-download`, its byte count, and the
bundle publisher prints its SHA-256 digest. Authenticate that digest or a
signature outside the bundle when publishing the downloadable file. A
`QM_ALLOW_TEST_SIGNING_KEY=1` run only validates the pipeline; it is not a
public release.

See [signing keys and bootstrap trust](../compiler/docs/PACKAGE.md#signing-keys-public-keys-and-bootstrap-trust)
for custody, provisioning and rotation limits. The public key is an owned
`/etc/apk/keys/<basename>` payload; the private key never enters a bundle/source
asset. Release inputs record SHA-256 of the **exact public PEM file**; the
publisher separately compares DER public-component digests to check the pair.
A bundle checksum is not a detached publisher signature, and a downloaded
checksum/key cannot approve its own download. No test key is promoted to
production by this flag.

Before building the kernel or the release-wide ELF population, the build also
post-link compiles the toolchain's linked `readelf`, `objcopy`, and `as`, verifies their
ELFs, and compares `readelf -rW` on linked GCC and `objcopy -O binary` on
linked readelf against their linked versions. It also compares the exact object
bytes produced by the two assemblers from `packaging/toolchain-preflight.s`.
A failing command stops the
build at this preflight instead of producing a formally verified but broken
download. A green result is cached by the exact compiler, verifier, test
script, and linked tool bytes; changing any one reruns the commands.

The extracted-bundle gate also starts a loopback HTTPS server with a
short-lived test certificate. The released `curl` must verify that certificate
and fetch a file; the released `git` must clone a repository over the same
verified TLS connection, and the cloned C source must compile and run. This
does not grant public network access or test the public CA bundle, but it
prevents a version-only or `file://` smoke test from certifying a broken TLS
client. A failure leaves the new bundle under a temporary candidate name,
not the stable download name.

## Native Release assets

The public distribution name is **OS Length3 Linux**. `build.sh` produces
`os-length3-linux-VERSION-x86_64-PUBLICATION.tar.zst`: one complete ordinary
root plus its kernel/initramfs and manifest. The native archive is a GitHub
Release asset, not a committed binary or an unprivileged host installer.
Receipts and download instructions live in [`releases/native/`](../releases/native/README.md).
Test-key builds must be marked as pre-releases, not production trust roots.

Publish the executable beside `SHA256SUMS` and a separate source asset.
After committing the recipe and matching source receipts, run from the repo:

```sh
node distribution/packaging/prepare-release-sources.mjs \
  temp/release-output/os-length3-linux-0.1.0-rc.1-sources.tar
```

This verifies the fixed upstream archives (including paired build-only zic),
the recipe commit and decoder gitlinks, then packages their compressed inputs
and build/configuration/patch/compiler sources without expanding a second
source forest. No signing private key, build-host disk or scratch tree enters
the asset. Record its digest and recipe commit separately; source availability
is not a claim of hash-identical reproduction under a different build host.
The source download is optional for executing the native bundle and is not
counted as executable delivery size.

`QM_BUILD_ROOT` keeps the disposable expansion on the build-host filesystem,
whose backing disk is under Windows `temp/`. Its default is
`$TMPDIR/libqm-linux-build`; `QM_OUTPUT_ROOT` likewise defaults to
`$TMPDIR/libqm-linux-output`. Checked-in `distribution/` contains only the upstream
source lock, configuration fragments, resolved exact `.config` locks, `/init`,
small bootstrap inputs, and the reproduction procedure. A future successful
Artifact publication may promote only the canonical immutable projection to
`releases/`; the current build stops before that boundary. `build.sh` refuses
to publish when a resolved config differs from its versioned lock.

To measure linked-x86 closure without rebuilding the distribution, reconstruct
only the uncompressed linker result from the same source digest and resolved
configuration lock:

```sh
cd distribution
QM_LINKED_KERNEL_ROOT=/tmp/libqm-linked-kernel-7.2.7 \
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
`mm`, `tty`, `seccomp`, and `net` suites stay below `distribution/` (or a verified
upstream source cache), execute against a disposable runtime overlay, and do
not change the identity of the minimal kernel + BusyBox artifact.

The pinned development-only x86 semantic references and their separate source
lock live under [`oracle/`](oracle/README.md). They certify the post-link
compiler but are not Linux, toolchain or browser Artifact inputs.

Update policy:

1. Read `https://www.kernel.org/releases.json` and select `latest_stable`.
2. Use a BusyBox release explicitly labelled stable by busybox.net.
3. Check each product package against its primary release page or signed tag;
   select the newest supported stable series, or record an explicit LTS
   exception. Update URLs and digests in `sources.env` together. Do not
   advance a version advertised on a page until its source archive and
   checksum can actually be fetched and pinned.
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
ownership database. The Artifact writer remains red.
The publication boundary re-applies the current profile to reused component
roots before signing: optional forbidden command names are excluded in a
short-lived, owner-sharing namespace. Component ELF bytes remain unchanged,
and no file is removed from an already installed apk-owned root. This permits
package-policy fixes to resume from a verified post-link checkpoint; its
pre-package population count is not the final installed release population.
The final path projects
the authenticated apk-installed root into a demand-paged read-only filesystem at a reserved
physical address. Upstream Linux owns that mount and its VFS semantics.
Compiler code, headers, static libraries and trust anchors remain cold until
Linux opens them. The primary 75 MB (75,000,000-byte) gate applies to the canonical program
word emitted from the kernel/boot/root semantics; Storage reports compressed
transfer bytes later and separately.

`packaging/build-system-tools.sh` assembles that verified linked-toolchain
package set only as a disposable dependency sysroot, builds every remaining standard-profile provider
from the official locked source, checkpoints each package independently and
removes build-only files from the runtime projection. `build.sh` merges the
boot, init, toolchain, core-tools and system-tools roots only for analysis and
closure measurement. That union is not a package or release. The product path
must return every optimized ELF to its original
package root, create and sign apk v3 packages and their index, install the exact
world into a private candidate, and pass
`packaging/check-package-publication.sh` before Artifact publication. This
signed apk transaction is now the only product-root constructor; the raw union
remains a build-only analysis checkpoint. Artifact publication is the remaining
red boundary. `packaging/check-root.sh` proves payload closure but cannot by
itself call a raw package union a release. The normative metadata, dependency, ownership,
script/trigger, and transaction policy is
[`../compiler/docs/PACKAGE.md`](../compiler/docs/PACKAGE.md).
