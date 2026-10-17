# OS Length3 Linux — native candidate, 2026-10-02

This page retains the original RC measurements. The current initial stable
native delivery is [Release 0.1.0](RELEASE-0.1.0.md), with its new repaired
bundle, external bootstrap policy and separately reported acceptance limits.

The downloadable candidate is
`os-length3-linux-0.1.0-x86_64-1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195.tar.zst`.
It contains the complete fixed `development-standard-v1` root, its manifest,
post-linked ordinary x86-64 executables, kernel and initramfs. No browser,
Wasm runtime, runtime x86 interpreter, source forest or second package archive
is required to execute the extracted native programs.

**Status: functional pre-release candidate, not production-approved.** The local
package signatures use a test key. The raw strict speed comparison is red;
the user accepts that small difference for the current correctness stage.
It is not the active blocker and is not evidence of a speedup. Neither global
minimality nor browser completion is claimed.

## Key and download trust

The frozen publication records `package.public-key.sha256` as
`872070838751f9ba52b49c4198277d071f91ce1a1e130e10df59a203de13271e`
in `verification/release-1a0bddc2340a...inputs`. This is SHA-256 of the exact
**public PEM file**, not the DER key-pair ID, a certificate pin or a production
endorsement. Matching public bytes are owned by `package-trust` under
`/etc/apk/keys`; no signing private key is a release/source payload.

The archive digest is separately
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
`SHA256SUMS` records byte identity, but the publisher has not emitted a detached
signature. Obtain the expected digest/signature through an independently
trusted channel before extraction. A checksum, key or manifest downloaded
inside/beside the same untrusted bundle cannot self-authenticate it. This
test-key candidate remains a pre-release. See
[key custody, fingerprints and rotation](../../compiler/docs/PACKAGE.md#signing-keys-public-keys-and-bootstrap-trust).

## Actual measurements

| Measurement | Result |
| --- | ---: |
| Exact download | 63,219,311 bytes |
| Complete linked-input canonical filesystem | 517,221,624 bytes |
| Complete optimized canonical filesystem | 251,808,351 bytes |
| Filesystem reduction | 51.315% |
| Post-linked ELF input/output population | 479,197,872 / 199,325,312 bytes |
| ELF compilation calls | 199 |
| Signed installed packages | 45 |
| QEMU TCG full-root ready marker, new single observation | 1,826.0 ms |
| Prior fixed 11-workload weighted native wall-time ratio | 1.002329099 (red) |

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

This distribution was re-baked after the compiler refactor, reusing unchanged
upstream/component checkpoints but re-running all 199 ELF post-link calls and
kernel compilation. The new bundle's extracted runtime, upstream development,
certificate-verified curl/Git HTTPS, and actual kernel/root boot passed.
All 383 ELF paths and 31 archive paths in the optimized package population
are byte-identical to the previous compiler output; the optimized kernel ELF
is also byte-identical. See `compiler-refactor/payload-comparison.log` and
the new release inputs. The package/publication and initramfs identities are
new; old receipts remain historical rather than being renamed.

The prior fixed native benchmark used 401 alternating pairs per workload, one guest
CPU and no concurrent bake, against the complete original linked population.
It ran native x86 on a WHPX build guest; the host kernel was Alpine Linux
6.18.35, not the included distribution kernel. All workload observations
matched, but aggregate execution time was 0.233% worse. GCC and Git identity
calibrations are retained alongside the failed result. They do not turn it
green. Its execution ratio is retained because the executable bytes match,
not presented as a newly timed benchmark. No cycle, retired-instruction or
bare-metal claim is made.

The new 1.826-second ready marker is one QEMU TCG oracle observation with a prepared
system image. It excludes download and extraction and is not a browser or
statistical cold-start guarantee. LTP, glibc testsuite and the complete requested
kselftest families have not been claimed as passed.

## Open the payload

On Linux x86-64, authenticate the bundle with a separately trusted digest or
signature before extraction. For this local candidate, `SHA256SUMS` records
the digest obtained from the authenticated build connection:

```sh
sha256sum --ignore-missing -c SHA256SUMS
mkdir opened
tar --zstd -xf os-length3-linux-0.1.0-x86_64-1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195.tar.zst -C opened
```

`opened/root` is an ordinary Linux root. Enter it through an isolated Linux
VM or a correctly configured mount/user namespace, supplying `/dev`, `/proc`
and writable scratch/workspace mounts. Ordinary native execution uses the
host Linux kernel. A plain `chroot` is not a security sandbox. A friendly
unprivileged launcher and an autonomous disk image are not supplied here.

The included `root/boot/kernel` and `root/boot/initramfs` were tested separately
using `distribution/oracle/check-native-boot.mjs` and a SquashFS projection of this exact
root. Those oracle inputs and tools are not duplicated into the download.
Package mutation and external networking require an explicit repository,
writable derived root, resolver and network grant; offline package queries,
C development and local Git do not.

The new receipts are `release-1a0bddc2340a...inputs`, its `.population` and
`.exact-pages.population`, `full-bake-refactor-oct02.log`,
`refactor-identities.sha256`, `refactor-native-boot.log`, and `acceptance.env`.
The previous `3238ae02...`, `native-boot.log` and benchmark logs identify the
earlier candidate. Raw build logs retain the pre-rename `qm-linux` transport
filename; renaming the new archive to `os-length3-linux` changes no payload byte.

The separate `os-length3-linux-0.1.0-rc.1-sources.tar` Release asset supplies
the fixed authenticated upstream archives and recipe/configuration/patch/
compiler sources, including the decoder submodules and original license
notices. It is optional for execution and excluded from executable download
size. Follow `RELEASE-SOURCE.txt` and `recipe/data/README.md` after extraction.

See `verification/` for the immutable input identities, build log, full boot
log, filesystem populations and the unhidden prior red performance result.
