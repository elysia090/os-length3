# Reproducible native Linux system layer

`build.sh` produces deterministic x86-64 musl package-owner roots. Ordinary
compiler/linker output is never an installed-root transformation input. The
roots stay distinct through the release-wide post-link schedule, and every
ordinary ELF produced by `postlink-compiler` is returned to the same package
and path, then checked by `postlink-verify` against its linked source and again
without a sidecar. Those final bytes are the only bytes which may later enter
an `.apk`, its signature, the installed database, and the authenticated release
root. Hard-linked paths retain one optimized inode inside one ownership
domain. A missing compiler, an unproved ELF, or a failed optimized GCC, Git or
curl smoke test aborts the build.

The current `.packages` manifest is a build-only root-set checkpoint while the
signed apk repository publisher is being connected. It contains package names
and owner-root coordinates; it is neither a product format, artifact identity,
installed root, nor a release-size proof. The release build checks the complete
standard profile and hands the signed optimized package closure to the ARTIFACT
publisher. Only that publisher may report canonical
program-word bytes. STORAGE may subsequently report transfer bytes for a
chosen delivery projection; a tar or SquashFS extent cannot stand in for
either number. The old 114,573,312-byte SquashFS remains only a historical
transfer baseline.

The layer contains:

- musl libc headers, startup objects and static libraries;
- Linux UAPI headers from the exact kernel source lock;
- C-only GCC without the LTO executables, GNU binutils and GNU make;
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

Every upstream URL and cryptographic digest is fixed in `../sources.env`.
The host bootstrap is independently fixed by `../bootstrap/flake.nix` and
`../bootstrap/flake.lock`; `build.sh` automatically enters that environment before it
resolves any compiler or build tool.
GCC's GMP, MPFR, MPC and gettext inputs use the exact SHA-512 values published
inside the pinned GCC source; the recipe never invokes GCC's networked
`download_prerequisites` helper. Downloaded official archives are cached in
`../upstream`. Expanded sources and compiler objects default to
`$TMPDIR/libqm-toolchain-work` on WSL's native filesystem because they are
reconstructible and have a metadata-heavy lifetime. Completed package roots,
post-link publications and package-set manifests default to the repository's ignored
`temp/toolchain-build` and `temp/toolchain-output` directories, so an
interrupted build resumes from the last verified package without treating an
incomplete source directory as a checkpoint. The source lock is also installed
as `/usr/share/qm/sources.env` so a running guest can identify the inputs that
produced its immutable layer.

The baseline intentionally omits LTO. The requested boot environment needs a
complete C compile/link path, while `lto1` and `lto-dump` alone accounted for
about 87.6 MB of the measured 323.3 MB unoptimized unique-file population.
LTO may later be a separately fetched cold object; it is not allowed to inflate
the 75 MB (75,000,000-byte) default distribution.

The browser compiler remains a separate WebAssembly frontend. Native GCC and
the utilities are already post-link-compiled x86 programs. The native sandbox
executes those ELFs directly; the browser lowers the same accepted ELFs to its
VM projection. Neither profile decodes or optimizes them at runtime.

Example:

```sh
cd data/toolchain
QM_TOOLCHAIN_WORK_ROOT=/tmp/libqm-toolchain-work ./build.sh
```

`QM_TOOLCHAIN_BUILD_ROOT` and `QM_OUTPUT_ROOT` override the durable checkpoint
and output locations. `QM_TOOLCHAIN_WORK_ROOT` overrides only reconstructible
source/object scratch; it must not be used as the published checkpoint.

The C products default to
`src/v2/postlink-compiler/build/postlink-compiler` and
`src/v2/optimized-x86/build/postlink-verify`. Override them with
`QM_POSTLINK_COMPILER` and `QM_POSTLINK_VERIFY`; their joint digest is part of
the disposable build-cache key. It does not become a second distribution
identity.

The build compiles and runs `smoke.c` from a disposable union of the linked
package roots,
rejects an unexpected dynamic interpreter, checks its current VFS paths, and
prints the package-set checkpoint path. The release build later runs
`../distribution/optimize-payload.sh` for each package owner and emits a build
report beside that owner. It separates path bytes from the
digest-quotiented canonical ELF payload, so hardlinks and equal byte objects
cannot inflate the storage result. `../distribution/measure-root.sh` repeats
the quotient over the assembled root, including duplicates across package
boundaries. Its `canonical_filesystem_bytes` charges the unique regular-file content
plus the canonical inode/path/symlink/xattr graph; `canonical_payload_bytes`
is retained as the content-only diagnostic
term. This complete filesystem spelling is an Artifact-input upper bound, not
the normative `standard_release_size` and not Storage transfer bytes. The
75,000,000-byte gate belongs only to the emitted Artifact program word. The payload does not
carry a duplicate per-file manifest because every proof is already inside its
ELF. There is no
Python or SquashFS publication route. The only accepted continuation is the C
ARTIFACT publisher followed by the independent STORAGE delivery projection.

`audit-guest.sh` is the runtime acceptance test. Feed it to the serial shell
after the system image is mounted; it requires every command to resolve below
the read-only `/usr`, compiles and runs a static C program, exercises parallel
GNU make, creates a Git commit, checks the TLS/CA/pkg-config surface, and
round-trips a compressed archive.
