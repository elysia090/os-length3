# OS Length3 Linux 0.1.0

This is the operator-approved initial **stable native** distribution release,
superseding `0.1.0-rc.1`. The executable bundle is **63,651,568 bytes**, SHA-256
`56229f242fd8860583cb8b17b5f64f21aced1abad99770b306a0432fc260d7b4`.
It contains one normal Linux x86-64 root, its manifest, signed installed APK
state, optimized ordinary ELFs, kernel and initramfs. Linux, musl, s6/s6-rc,
mdevd, GCC/binutils/make, Git/curl/OpenSSH clients, CA certificates and the fixed
system/network/archive/account/editor closure are included.

The update fixes relative jump-table base reuse which caused the prior
optimized BusyBox route command to fault. BusyBox shell and xargs now honor
the profile's standard command providers. Two clean fixed producer builds and
actual descriptor-bound compiler/verifier/archive/stage/audit execution are
recorded. The native archive was reproduced byte for byte and its extracted
root passed runtime, C/make/upstream development and certificate-verified
curl/Git HTTPS tests. The included kernel/root and the Web projection also
passed the same offline shell/files/permissions/links/process/archive/ELF,
C/make/Git/AES/APK workload. Current Web storage faults, quota, ENOSPC and tmpfs
cycles are separately recorded; they do not certify host resource management.

## Download and authenticate

Approve `elysia090/libqm-prototype` as the publisher through its authenticated
GitHub Release channel. Retain this exact version and bundle digest before
accepting bytes from a mirror. SHA256SUMS records identities; it is not a
detached signature. On Linux, in a directory containing the downloaded bundle:

```sh
printf '%s  %s\n' \
  56229f242fd8860583cb8b17b5f64f21aced1abad99770b306a0432fc260d7b4 \
  os-length3-linux-0.1.0-x86_64-ffb53450f0f41900f1cda2cd072b9405b43c7b44f97c400794c57019578f32a9.tar.zst | sha256sum -c -
mkdir opened
tar --zstd -xf os-length3-linux-0.1.0-x86_64-ffb53450f0f41900f1cda2cd072b9405b43c7b44f97c400794c57019578f32a9.tar.zst -C opened
```

`opened/root` is a normal root for Linux x86-64 with tar/zstd and an isolated VM
or appropriate mount/user namespaces. A plain chroot is not a sandbox. This
download supplies no host installer, unprivileged launcher or autonomous disk
image. Native root execution uses the host kernel; the included kernel has a
separate exact guest-boot acceptance. Writable workspace mounts, package
mutation, network grants and resolver configuration are explicit operations.

## Trust and source assets

The existing local APK signing key is unchanged. Its public PEM is installed
in `package-trust` and separately downloadable; exact public-file SHA-256 is
`872070838751f9ba52b49c4198277d071f91ce1a1e130e10df59a203de13271e`.
It is authenticated as content by the externally pinned bundle. This release
does not promote it to an independently provisioned production repository key
or configure an online update repository. No private signing key, browser
workspace key or gateway credential is distributed. Bootstrap trust is the
approved GitHub publisher channel; an independent detached release signature
has not been emitted. Key custody and a future trusted repository/key
transition remain explicit operator work.

`release-manifest.json` names exact assets, source/build conditions and limits.
The source asset contains the exact clean producer source archive, actual
applied publication-driver overrides, 48 pinned original upstream archives
and the producer cut/execution/toolchain records. Individual upstream license
and copyright notices remain authoritative. The source instructions distinguish
producer inputs from publication overrides and require operator-provided
signing authority; cross-host hash-identical signed reproduction is not claimed.
The evidence asset contains the extracted-native receipt, executed producer
binding and current paired acceptance. Historical receipts are kept intact.

## Measured scope and remaining work

The stable native decision accepts the initial delivery milestone and its
listed limits. It does not convert missing later product gates into passes:

- The independent complete transformed-ELF semantic checker is not implemented.
  The existing structural verifier accepted a known bad old BusyBox. The actual
  fault is fixed and its finite regression passed; structural metadata alone
  is not a whole-program equivalence proof.
- The canonical 75,000,000-byte Artifact word is not emitted/measured. Native
  transport compression is a different quantity.
- Browser execution remains preview. The latest measured cold prompt was
  160,397.6 ms, failing the three-second target. The new Web root's granted
  network workload was not repeated; older-root network receipts are distinct.
- Exact process suspend/resume, the native product resource launcher, paired
  performance speedup and real clock synchronization remain unqualified.
- Cloud synchronization is optional plumbing, not a configured service or a
  portable key/head recovery mechanism. The normal workspace recovery path is
  the user-approved browser profile/origin; deleting its site data loses it.

The old RC is retained. No existing workspace is migrated or deleted by
publishing this release, and no runtime application is forcibly stopped.
