# Native distribution candidate — 2026-10-02

The local downloadable candidate is
`qm-linux-0.1.0-x86_64-3238ae0211825f491739179b04c8235796ebfb0d9786a8488728c4e19a71992c.tar.zst`.
It contains the complete fixed `development-standard-v1` root, its manifest,
post-linked ordinary x86-64 executables, kernel and initramfs. No browser,
Wasm runtime, runtime x86 interpreter, source forest or second package archive
is required to execute the extracted native programs.

**Status: functional candidate, not an approved public release.** The local
package signatures use a test key. The raw strict speed comparison is red;
the user accepts that small difference for the current correctness stage.
It is not the active blocker and is not evidence of a speedup. Neither global
minimality nor browser completion is claimed.

## Actual measurements

| Measurement | Result |
| --- | ---: |
| Exact download | 63,219,319 bytes |
| Complete linked-input canonical filesystem | 517,221,624 bytes |
| Complete optimized canonical filesystem | 251,808,350 bytes |
| Filesystem reduction | 51.315% |
| Post-linked ELF input/output population | 479,197,872 / 199,325,312 bytes |
| ELF compilation calls | 199 |
| Signed installed packages | 45 |
| QEMU TCG full-root ready marker, one observation | 1,879.9 ms |
| Fixed 11-workload weighted native wall-time ratio | 1.002329099 (red) |

Download compression is transport-only. The 63.2 MB download does **not**
establish the separate 75,000,000-byte canonical program-word target. The
filesystem measure includes the full recipe, boot objects, package state,
trust roots, headers, resources and canonical metadata; it is not an ELF-only
or partial-toolchain figure.

## Verified scope

The exact downloaded bytes were extracted and checked, not merely the
pre-archive root:

- compiler proof-format and declared package/provider/resource closure;
- compiled s6-rc offline graph;
- static C compile/link/run, `make -j4`, archive tools and installed headers;
- upstream zlib configure/build/test/install and an installed consumer;
- Git initialization, commits, local clone and history;
- certificate-verified HTTPS GET, Git HTTPS clone and compilation of the clone;
- RSA signing, rejection of an altered message, AES/PBKDF2 round-trip;
- Ed25519 key generation/public-key readback;
- xz one-thread, two-thread and automatic-thread compression/readback;
- included optimized kernel -> actual PID 1/services -> terminal commands,
  C/make/Git/AES/apk and immutable lower/dirty COW isolation in QEMU TCG.

The fixed native benchmark used 401 alternating pairs per workload, one guest
CPU and no concurrent bake, against the complete original linked population.
It ran native x86 on a WHPX build guest; the host kernel was Alpine Linux
6.18.35, not the included distribution kernel. All workload observations
matched, but aggregate execution time was 0.233% worse. GCC and Git identity
calibrations are retained alongside the failed result. They do not turn it
green. No cycle, retired-instruction or bare-metal claim is made.

The 1.88-second ready marker is one QEMU TCG oracle observation with a prepared
system image. It excludes download and extraction and is not a browser or
statistical cold-start guarantee. LTP, glibc testsuite and the complete requested
kselftest families have not been claimed as passed.

## Open the payload

On Linux x86-64, authenticate the bundle with a separately trusted digest or
signature before extraction. For this local candidate, `SHA256SUMS` records
the digest obtained from the authenticated build connection:

```sh
sha256sum -c SHA256SUMS
mkdir opened
tar --zstd -xf qm-linux-0.1.0-x86_64-3238ae0211825f491739179b04c8235796ebfb0d9786a8488728c4e19a71992c.tar.zst -C opened
```

`opened/root` is an ordinary Linux root. Enter it through an isolated Linux
VM or a correctly configured mount/user namespace, supplying `/dev`, `/proc`
and writable scratch/workspace mounts. Ordinary native execution uses the
host Linux kernel. A plain `chroot` is not a security sandbox. A friendly
unprivileged launcher and an autonomous disk image are not supplied here.

The included `root/boot/kernel` and `root/boot/initramfs` were tested separately
using `data/oracle/check-native-boot.mjs` and a SquashFS projection of this exact
root. Those oracle inputs and tools are not duplicated into the download.
Package mutation and external networking require an explicit repository,
writable derived root, resolver and network grant; offline package queries,
C development and local Git do not.

See `verification/` for the immutable input identities, build log, full boot
log, filesystem populations and the unhidden red performance result.
