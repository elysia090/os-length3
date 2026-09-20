# Linux build host

The Alpine 3.24.1 cloud image and its frozen 313-package `installed.lock` are
the pinned *build host* only. They supply Linux build tools and an execution
oracle; they are not the product. The product `development-standard-v1` is a
separate from-source musl closure defined by `../sources.env` and
`../distribution/package-recipes.sh` (Linux, musl, GCC, binutils, BusyBox,
apk-tools, s6/s6-rc, ...), with its own signed apk world and service DAG, and
no bootstrap package is copied into the product root.

`linux.py` is the native-Linux equivalent of `windows.mjs`; it uses a local
`qemu-system-x86_64` instead of the Windows portable build:

```sh
python3 data/bootstrap/linux.py prepare   # image/key check, differential disk
python3 data/bootstrap/linux.py serve     # source.tar, upstream cache, NoCloud seed
python3 data/bootstrap/linux.py boot      # TCG, SSH forwarded on 127.0.0.1:18022
python3 data/bootstrap/linux.py ssh ...   # run a command in the guest
```

`boot` needs user-mode (slirp) networking; the minimal oracle built by
`../oracle/build-qemu.sh` deliberately disables slirp, so a slirp-enabled
`qemu-system-x86_64` is required for the host (the Windows portable build
provides it). QEMU 11 resolves slirp through the `subprojects/slirp.wrap`
git subproject, so a source build must have that checkout available and be
configured with `--enable-slirp`; `linux.py` then defaults to
`/tmp/libqm-x86-host/qemu-build-11.1.0/{qemu-system-x86_64,qemu-img,pc-bios}`
(override with `QM_QEMU`, `QM_QEMU_IMG`, `QM_QEMU_BIOS`). KVM is used
automatically when `/dev/kvm` is usable, with TCG as the fallback.

The host first populates `data/upstream/` with every archive pinned by
`../sources.env` (the build host serves this cache over HTTP, so the guest does
not reach upstream itself):

```sh
data/fetch-upstream.sh
```

After the guest is reachable, place the retained signed APK inputs in
`/build/bootstrap/packages` and run
`/build/source/data/bootstrap/install-tools.sh install`; a matching
`/build/bootstrap/installed.lock` is the environment gate. On the pinned Alpine
repositories `apk fetch --recursive` supplies the retained inputs; a package the
repository has superseded (for example an older `ca-certificates`) is fetched by
its exact filename from the same versioned repository path, or the lock is
refreshed as described below.

## Windows host

The build host is not the development-standard-v1 distribution. It supplies
Linux build tools and an execution oracle without NixOS, WSL, or a host install.
The product still consists of the locked upstream population in `../sources.env`
and `../distribution/profile.env`, post-linked before package publication.

`windows.json` pins the QEMU Windows download and the official Alpine bootstrap
image. QEMU's published SHA-512 and Alpine's detached GPG signature were checked;
the Alpine primary-key fingerprint comes from its official cloud-image page.
Download those files and the public key into `../upstream/bootstrap/` over HTTPS.
The preparation command checks both digests and the pinned image signer before
creating a differential disk. It extracts QEMU with 7-Zip, without running its
installer. It does not install software in Windows or modify host networking.

Run from the repository root using a native Windows Node executable:

```text
node data/bootstrap/windows.mjs prepare
node data/bootstrap/windows.mjs serve
node data/bootstrap/windows.mjs boot whpx
```

`serve` and `boot` are long-lived processes in separate terminals. The input
server listens only on `127.0.0.1:18081`. SSH is forwarded only on
`127.0.0.1:18022`; passwords are disabled and the generated key is local to the
ignored `temp/bootstrap/`. No host private keys are exposed to the guest.

```text
ssh -p 18022 -i temp/bootstrap/id_ed25519 -o UserKnownHostsFile=temp/bootstrap/known_hosts -o StrictHostKeyChecking=accept-new root@127.0.0.1
```

Use `boot tcg` explicitly if WHPX is unavailable. Neither is a product dependency.
Do not compare TCG emulation times with native hardware times. The bootstrap
execution configuration is recorded under `temp/bootstrap/execution.json`.
The 64 GiB sparse differential disk, input archive, keys and all build checkpoints
remain under Windows `temp/`. Clean shutdown with guest `poweroff` retains the
disk; the preparation command never resets an existing build checkpoint.

The current source snapshot is served as `/source.tar`; original source archives
are served without unpacking through `/upstream-index` and `/upstream/<filename>`.
Run `node data/bootstrap/windows.mjs snapshot` after source edits, while no
snapshot transfer is active, to refresh the snapshot. The server
does not accept writes, arbitrary paths, or serve `.git`, host keys or build trees.

The build tools are frozen in `installed.lock` (313 installed packages) and
`packages.sha256` (retained signed APK inputs). `install-tools.sh install`
verifies retained inputs, installs with networking disabled, and compares the
complete installed population. Only the explicit maintenance command
`install-tools.sh resolve` may propose a new population; inspect its generated
locks before updating this recipe. Every distribution build entry sources
`environment.sh`; merely setting an environment flag cannot bypass the check.
Bootstrap packages are never copied into the product root. Booting this host
alone does not prove the fixed distribution builds, postlinks, boots, or improves runtime.

The retained signed APK inputs track the current Alpine 3.24 stable point
release. They were last refreshed on 2026-09-20, which advanced
`ca-certificates` and `ca-certificates-bundle` to `20260909-r0`; the installed
population remains 313 packages and the Rust build closure remains 35. A refresh
is a lock change: `packages.sha256` and `installed.lock` are regenerated
together with `install-tools.sh resolve`, and `rust.sha256` /
`rust-installed.lock` with `rust.sh resolve`, then the host copies the new
locks back beside the recipe.

Git 2.55 also builds a Rust static library. Its build-only tools have a separate
35-package closure in `rust.world`, `rust.sha256` and `rust-installed.lock`.
`rust.sh install` verifies the retained signed inputs under
`data/upstream/bootstrap/rust-packages/` and installs them without scripts into
`temp/bootstrap-rust/roots/<identity>`, not the host's package database.
`rust.sh run ...` exposes this private tool prefix only to the child command,
with Cargo networking disabled. The Git checkpoint includes this closure's
identity; the already-built kernel, C compiler and other packages keep their
unchanged bootstrap inputs. Nothing from the Rust SDK is a release package.
Only the explicit `rust.sh resolve` maintenance command proposes new lock files.

Timezone generation uses the matching IANA `tzcode` source pinned in
`tzcode.env`, retained beside the other archives in `data/upstream/`.
The system builder builds its own `zic`; it does not depend on an untracked
host timezone compiler or copy a bootstrap timezone database into the release.
The `zic` identity changes only the timezone component checkpoint.

The full `data/build.sh` entry accepts existing `QM_INIT_BUILD_ROOT`,
`QM_CORE_BUILD_ROOT`, `QM_SYSTEM_BUILD_ROOT`, and `QM_LINKED_KERNEL_ROOT`
coordinates. Point these at the component checkpoints to avoid rebuilding
already verified inputs. It still validates package sets and kernel config;
selecting a work directory is not permission to skip any publication gate.
`data/build-linked-kernel.sh [vmlinux|bzImage]` is the sole kernel builder used
by both the linked-input check and the full distribution recipe. The latter
reuses its objects to build the boot wrapper rather than expanding Linux a
second time. Keep `QM_BUILD_ROOT`, `QM_OUTPUT_ROOT` and `QM_SCRATCH_ROOT`
under the Windows-backed guest disk's `/build/source/temp/`.

The resolved Linux 7.1.8 configuration was regenerated for GCC 15.2.0,
binutils 2.45.1 and pahole 1.30 from this host, without changing its kernel
feature choices. The prior Nix compiler capability/version fields are not
reusable measurement inputs. `SOURCE_DATE_EPOCH` comes from the release profile;
kernel build user/host/version/timestamp are fixed. Compiler-dependent object
checkpoints include the bootstrap identity, preventing stale objects from an
earlier tool population from being reused under an unchanged command name.

References: [QEMU Windows downloads](https://www.qemu.org/download/#windows),
[Windows build and checksum](https://qemu.weilnetz.de/w64/),
[Alpine cloud images and signing key](https://www.alpinelinux.org/cloud/),
[NoCloud seed contract](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html).
