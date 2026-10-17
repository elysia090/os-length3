# OS Length3 Linux 0.1.0-rc.1

This pre-release contains the fixed `development-standard-v1` Linux environment:
the included Linux kernel/initramfs, musl, BusyBox, s6/s6-rc/mdevd, apk-tools,
GCC/binutils/make and headers, Git/curl/OpenSSH-client and CA roots, system,
network, archive, filesystem, account and editor tools.

The complete linked population is post-link compiled into ordinary x86-64
ELFs. This candidate is rebuilt with the responsibility-split compiler, not
the bundle from before that refactor. There is no browser runtime dependency
to use the extracted native programs on an appropriate Linux x86-64 host.

The new executable download is **63,219,311 bytes**. Its complete canonical
filesystem is 251,808,351 bytes versus the fixed linked population's
517,221,624 bytes (51.315% reduction, independently of transport compression).
All 199 ELF calls, package/resource closure, extracted C/make, upstream build,
certificate-verified curl/Git HTTPS and exact kernel/root boot passed.
One QEMU TCG ready observation was 1,826.0 ms, excluding acquisition and extraction;
this is neither a browser nor a statistical cold-start guarantee.

## Assets and verification

- The `.tar.zst` asset is the executable bundle, with `manifest` and `root/`.
- `SHA256SUMS` authenticates asset bytes when obtained from a trusted channel;
  it is not a detached release signature.
- The separate `*-sources.tar` asset retains the fixed original upstream
  archives, configuration, patches, compiler/build sources and decoder
  submodules. Existing compressed sources are not inflated into another tree.
  Their own copyright and license notices remain authoritative.
- `README.md` and versioned `artifact/native/verification/` give the measured
  population, exact input identities, extracted-bundle checks and native boot
  evidence. Read these before executing the candidate.

Download the executable and SHA256SUMS into one directory, then on Linux:

```sh
sha256sum --ignore-missing -c SHA256SUMS
mkdir opened
tar --zstd -xf os-length3-linux-0.1.0-x86_64-*.tar.zst -C opened
```

`opened/root` is a normal Linux root, not a host installer. Use an isolated
Linux VM or appropriate namespaces/mounts; a plain chroot is not a sandbox.
No unprivileged launcher or autonomous disk image is supplied. The included
kernel/initramfs and exact root have a separate QEMU boot test. Writable root
changes and external networking need explicit policy and grants.

## Candidate limitations

Package signatures use a local test key, not an established production trust
root. This pre-release does not establish a security audit, global optimality,
the canonical-program-word size target or the complete LTP/glibc/kselftest
families. The prior fixed native timing difference was accepted for this
correctness stage; it is not evidence of a speedup. New measurements are
recorded separately, without relabeling the old comparison.

The next milestone is to run **this same authenticated bundle** on Wasm in a
real browser: Linux boot/PID 1, offline terminal, C compile/run, `make -j4`,
local Git and apk queries, then granted Git/HTTPS. Linux remains the syscall,
process, VFS and networking authority; browser adapters do not reimplement
POSIX or interpret x86 in JavaScript. Browser completion is not claimed here.
