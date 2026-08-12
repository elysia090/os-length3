# Reproducible x86 Linux input

`artifact/linux-x86-64` is generated only from the upstream inputs locked in
`sources.env`. Local WSL kernels and `qm-linux-spike` are diagnostic references,
not artifact inputs.

The current source roles are:

- Linux 7.1.8, the stable release published by kernel.org on 2026-08-09.
- BusyBox 1.37.0, the latest BusyBox release labelled stable; 1.38.0 is still
  labelled unstable by the upstream project.

`build.sh` downloads both HTTPS tarballs, verifies their pinned SHA-256 values,
builds a deliberately small legacy-PIC x86-64 kernel matching the implemented
machine, builds static BusyBox, creates a deterministic `newc` initramfs, and
publishes a new canonical boot object plus its page delivery.

Run it in NixOS/WSL with the ordinary kernel build tools available. The script
resolves the static BusyBox compiler from `pkgsMusl.gcc` and the host-only
libelf headers from `elfutils.dev`; neither becomes a runtime input:

```sh
cd data
nix shell \
  nixpkgs#gnumake nixpkgs#gcc nixpkgs#flex nixpkgs#bison nixpkgs#bc \
  nixpkgs#cpio nixpkgs#xz nixpkgs#perl nixpkgs#rsync nixpkgs#pkg-config \
  nixpkgs#openssl nixpkgs#elfutils nixpkgs#pahole \
  -c env QM_BUILD_ROOT=/tmp/libqm-linux-build ./build.sh
```

`QM_BUILD_ROOT` deliberately keeps the disposable expansion on WSL's native
filesystem instead of importing any WSL kernel. Without it, generated trees
stay below ignored `data/build`; final scratch outputs stay in ignored
`data/out`. Checked-in inputs are the source lock, configuration fragments,
resolved exact `.config` locks, `/init`, and this procedure. `build.sh` refuses
to publish when a resolved config differs from its versioned lock.

Update policy:

1. Read `https://www.kernel.org/releases.json` and select `latest_stable`.
2. Use a BusyBox release explicitly labelled stable by busybox.net.
3. Update URLs and digests in `sources.env` together.
4. Regenerate and review the versioned exact `.config` locks.
5. Build and verify `/init`, the BusyBox prompt, `uname -a`, and `ls /` in the
   real browser before publishing the artifact.
