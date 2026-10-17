# Package publication and installed state

This contract keeps the distribution package boundary as strict as its
executable, Artifact, and Storage boundaries. `apk` is the package solver and
transaction engine. It is not a convenient way to unpack a previously merged
filesystem tree.

## Observable package state

A package transaction is correct only when every later package and filesystem
observation is determined by four finite components:

```text
PackageState = Info + DependencyGraph + PathOwner + Effects.          (1)
```

`Info` identifies the package and its reproducible build. The dependency graph
determines solver choices and transaction order. `PathOwner` determines the
exact filesystem contribution of every selected package. `Effects` determines
the signed scripts and directory triggers that may run around a transaction.
Omitting any component equates states that can later differ under `apk add`,
`apk del`, `apk fix`, `apk audit`, a trigger, or a filesystem read. Once all
four are fixed, no build-tree or merged-root history is required.

The release publishes ordinary apk v3 packages and an ordinary apk v3 index.
It adds neither a private package container nor a parallel ownership database.
The guest-visible repository coordinate is fixed at
`/system/apk/Packages.adb`. The VM exposes the authenticated repository there;
no host build path is serialized into `/etc/apk/repositories`, and Linux plus
`apk` remain the sole package and filesystem authority.

## Fixed publication path

Package roots remain distinct from installation through signing:

```text
fixed source closure
        |
ordinary package builds with relocation-bearing linked x86
        |
release-wide post-link compile schedule
        |  discovery may be shared; output ownership may not
        v
optimized package roots: ordinary ET_EXEC / ET_DYN + embedded proof
        |
apk mkpkg --sign-key KEY --files ROOT --info ...
          [--script ...] [--trigger ...]
        |
apk mkndx --sign-key KEY signed-packages... -> Packages.adb
        |
offline apk transaction into a private candidate root
        |
solver / installed-db / ownership / audit / closure gates
        |
Artifact identity -> Storage delivery -> atomic current-root publish.       (2)
```

The post-link compiler may discover equivalent instructions, blocks, pure
slices, immutable reads, and archive members across the complete release. It
must return each transformed ELF to the package and path that owned its linked
input. A package never acquires an undeclared dependency on another package's
private executable extent. Equal immutable bytes that remain in different
valid ELFs are shared later by Artifact identity; moving them into a private
release code store would make the outputs cease to be ordinary ELFs.

A union of raw package roots is useful only as an analysis population. It is
not a package payload, installed system, release root, or publication gate.

## Signing keys, public keys and bootstrap trust

The publisher, not the guest VM or storage provider, holds the private key.
`publish-apk.sh` accepts these explicit operator inputs:

| Input / product | Meaning and custody |
| --- | --- |
| `QM_APK_SIGNING_KEY` | Existing PEM private key, outside the repository by default; used by `apk mkpkg` and `apk mkndx`. Never a package, Artifact, source/download asset, browser setting or log value. |
| `QM_APK_PUBLIC_KEY` | Matching PEM public key. Its basename is installed under `/etc/apk/keys/` and owned by `package-trust`. Public bytes are distributable; their authority must be established independently. |
| `QM_APK_OPENSSL` | Actual OpenSSL executable for key-pair checking, not a signing/trust shim. The ordinary build supplies its toolchain OpenSSL. |
| `QM_ALLOW_TEST_SIGNING_KEY=1` | Relaxes only the private-key repository-location guard for disposable tests. It neither disables signature verification nor approves/labels a production release automatically. |

Before the first transaction, publication seeds the candidate's trust directory
with the same public bytes which the signed `package-trust` package will own.
Every package and `Packages.adb` must pass real `apk verify`; the offline
transaction, ownership and audit gates follow. There is no `--allow-untrusted`
publication path or public-key mutation after installation.

Two deliberately different fingerprints exist:

```text
key_pair_id = SHA256(DER public component of the private/public key)
package.public-key.sha256 = SHA256(exact public PEM file bytes)
```

`publish-apk.sh` compares the first on both inputs and rejects mismatch or
private-key material in the public input. `distribution/build.sh` records the second
in release inputs and the publication checkpoint. PEM reformatting can change
the second without changing the first. Neither is a certificate fingerprint
or a storage-encryption key.

For an already provisioned key, derive a **new** public file outside the tree
and inspect only public identities:

```sh
umask 077
test ! -e /secure/release.public.pem
openssl pkey -in /secure/release.private.pem -pubout -out /secure/release.public.pem
openssl pkey -pubin -in /secure/release.public.pem -outform DER | sha256sum
sha256sum /secure/release.public.pem

QM_APK_SIGNING_KEY=/secure/release.private.pem \
QM_APK_PUBLIC_KEY=/secure/release.public.pem \
  ./distribution/build.sh
```

Paths are examples, not shipped files. Provisioning, backup, access control and
production approval remain operator obligations. Do not print private
components or put passphrases in command arguments/logs. The file-based CLI
has no HSM, key-agent, automatic rotation/revocation or protected-key unattended
signing integration. The public-output options are specified by
[OpenSSL pkey](https://docs.openssl.org/3.5/man1/openssl-pkey/).

Signing is outside the expensive post-link checkpoint: a new public key
re-signs packages/index, repeats transaction/audit checks and produces a new
publication/root/download identity without recompiling unchanged x86.
A successor key must be approved through an already trusted or independent
channel, never merely supplied by a mirror. Revoking a compromised key also
requires an independently trusted policy update; these deployment operations
are not automated here.

APK signatures do **not** authenticate the enclosing native archive or browser
release descriptor before it is opened. Obtain the download's expected
digest/signature and publisher trust independently first. An internal public
key, manifest, checksum or ELF proof cannot approve its own untrusted container.
`publish-native-bundle.sh` currently emits a digest, not a detached publisher
signature; that external-authentication gate still applies.

The frozen native candidate's key remains local/test-only; its public-file
fingerprint is in [`releases/native/README.md`](../../releases/native/README.md).
The 2026-10-13 initial stable native publication authenticates that unchanged
key as installed content through the approved external archive digest; it
does not promote it to a production repository authority. Bootstrap and future
key-transition policy are in [DELIVERY.md](DELIVERY.md).
Browser volume secrets and network credentials are separate authorities in
[STORAGE.md](STORAGE.md) and [NETWORK.md](NETWORK.md), never derived from the
package private key.

## Package information and dependencies

Every package fixes, at minimum:

* name, version/revision, architecture, description, URL, license, origin and
  reproducible build identity;
* dependency constraints, provides, provider priority, conflicts/replaces,
  replacement priority, install-if and layer where applicable;
* the exact release CPU contract and the digest of its source/build recipe;
* its runtime-closure declarations for `dlopen`, helper lookup, shebang/exec
  targets, service inputs, configuration and non-command data.

Versions come from `distribution/sources.env`; the selected closure and command
providers come from `distribution/packaging/profile.env`. The signed repository
index is the only solver input for a release. The release world uses exact
constraints, the index identity is fixed by the release root, and a solver
result is rejected if it is ambiguous, incomplete, or selects a package outside
that repository. Runtime `apk add` creates a new workspace `system-root`; it
never changes the immutable release identity.

The standard profile names concrete dependencies and gives no automatic
priority to its informational, unversioned `cmd:` providers. Replacements,
`install-if`, layers, scripts, and triggers are empty unless a later profile
declares and gates them explicitly. Package/index content hashes identify the
exact final metadata and payload; the release input record separately binds the
source lock, CPU/profile contract, post-link package-set identity, publication
implementation, public key, and signed index.

Build dependencies are not runtime dependencies. Conversely, static linking
does not erase a semantic dependency on an executable helper, service,
provider, trigger, configuration file, or dynamically opened object. The gate
derives ELF interpreter and `DT_NEEDED` edges and checks every declared non-ELF
edge. Source-package habit and package names are not closure proofs.

For `development-standard-v1`, the machine-readable policy in
`distribution/packaging/profile.env` fixes the following decisions:

| Surface | Standard policy |
| --- | --- |
| selection | exact world; no floating constraint or automatic `install-if` selection |
| dependencies | explicit package-name DAG; signed metadata must equal the recipe |
| virtual providers | informational unversioned `cmd:` names; no provider priority |
| replacement | no `replaces` edge and no replacement priority |
| database layer | root only; no uvol or secondary installed database |
| lifecycle effects | no install, upgrade, deinstall, trigger, or commit-hook script |
| transaction log/cache | not retained in the immutable root |
| package payload | one final owner per persistent non-directory path |

These are observed properties of the signed and installed packages, not
defaults inferred from missing recipe syntax. Publication queries the complete
installed population and rejects any non-default solver/effect field.

## Filesystem ownership

The installed apk database is authoritative for package ownership, and its
records describe the same final bytes that were signed and admitted into
Artifact identity. Persistent paths have exactly one of three authorities:
signed package payload, apk transaction state, or a declared writable
workspace/service state. No fourth, unowned class exists.

* Every persistent non-directory payload path in the immutable release has
  exactly one final package owner. Kernel, initramfs, service database, trust
  roots, release metadata, and base layout are included; none may appear as
  unowned assembly output.
* The world, installed database, transaction log, and package cache indices are
  apk transaction state. Their authority is the selected signed package set and
  transaction result, never a package that circularly claims its own database.
  Only the world and installed database required to reproduce the root are
  retained in the immutable release; logs and caches are excluded.
* More than one package may mention a directory only when owner, group, mode,
  xattrs, and type are identical. Directory co-ownership never permits
  conflicting children or metadata.
* A non-directory collision is an error unless an explicit solver-visible
  replacement relation selects one final owner. Merge order, extraction order,
  and last-writer-wins are never semantics.
* A package records path type, owner, group, mode, xattrs/capabilities, link
  target or hard-link relation, and content identity. Hard links remain within
  one package ownership domain. Cross-package equality is shared by Artifact
  identity instead of hidden ownership aliasing.
* `/etc` package files are immutable baselines. Workspace modifications are
  protected COW configuration and follow apk configuration-file conflict
  behavior; they do not mutate the signed lower root.
* `/run` and `/tmp` are volatile. Declared `/var` service state and workspace
  data live in writable roots. Reconstructible caches are not release content.

Publication compares package path records with one fused traversal of the
candidate. Missing, modified, conflicting, and unowned persistent paths are
errors. The comparison is population-linear; it does not invoke one `apk`
query per path. The standard profile additionally binds command and critical
resource coordinates to their expected package owner; merely finding the same
pathname in a different signed package is not sufficient.

## Scripts and triggers

All pre/post install, deinstall, and upgrade scripts and every directory-trigger
pattern are part of the signed package. Their interpreter and every command or
resource they can reach are dependency and closure edges.

The standard release admits no package lifecycle script, directory trigger, or
apk commit hook. The s6-rc database, CA bundle, base accounts, and every other
deterministic derived file are built before `apk mkpkg` and owned by explicit
packages. `apk add --no-scripts --no-commit-hooks` is defense in depth while
assembling a candidate; it is not permission to ignore signed effects. A
package that declares an effect is rejected after the transaction as well as
by the recipe gate.

A future effectful profile must use a new profile and policy-schema identity.
For each effect it must bind the script type, content digest, in-root
interpreter, dependency closure, trigger globs, writable path set, ordering
edges, retry/idempotence rule, and failure semantics. No effect inherits this
authority from a package name or from merely being signed.

Any allowed effect executes only inside the private candidate root with:

* no network, host filesystem, ambient credentials, or host environment;
* fixed locale, umask, PATH, working directory, and deterministic clock input;
* only in-root interpreters and commands;
* a declared writable set confined to volatile or workspace state;
* idempotence under retry and atomic failure of the complete transaction.

A trigger is bound to canonical directory globs and runs only because the same
transaction changed a matching owned path. It cannot be an undeclared
post-install hook. If a persistent derived output is needed, publication signs
a package that owns it rather than accepting an unowned trigger result.

## Gates and retained products

A package publication is green only when all of the following hold:

1. `apk verify` accepts every package and the repository index under the
   release package trust root;
2. resolving the exact world offline yields exactly the fixed package closure;
3. the installed database names every selected package and no other package;
4. dependency and transaction ordering are closed, with no undeclared helper,
   interpreter, dynamic object, service input, script, or trigger edge;
5. one candidate traversal agrees with apk path metadata and the declared apk
   transaction/writable-state exclusions, and finds no other unowned persistent
   path, conflicting owner, changed content/mode/xattr, dangling link, or
   undeclared device node;
6. every ET_EXEC/ET_DYN is the proved optimized ELF from its signed package,
   and `apk audit` is clean;
7. replaying the offline transaction is idempotent and produces the identical
   installed database and filesystem root;
8. only then does the candidate become Artifact input and an authenticated
   root become current.

Retained products are signed `.apk` files, the signed repository index, the
ordinary world/installed database, and the final Artifact/Storage projection.
Source trees, object directories, unoptimized linked roots, analysis unions,
package caches, and transaction scratch roots are build checkpoints, not
release content.

## Fixed standard package closure

The standard profile packages the complete functional closure rather than one
large `toolchain` payload:

* base layout, release metadata, Linux kernel/boot objects, BusyBox, and musl;
* skalibs, execline, s6, s6-rc, its compiled service database, and mdevd;
* apk-tools and package trust roots;
* util-linux, kmod, iproute2, dhcpcd, nftables, and chrony; static-only link
  inputs do not survive as empty runtime packages;
* e2fsprogs, shadow, libcap, acl, and attr;
* GCC C frontend, binutils, make, musl/Linux headers, and pkg-config;
* OpenSSL, CA roots, curl, Git, and OpenSSH clients;
* tar, gzip, bzip2, xz, zstd, cpio, patch, and file;
* tzdata, less, nano, and the small runtime libraries selected by the recipe.

Debug data, tests, manuals, build-only libraries, LTO programs, and package
caches remain outside the standard release. Removing them is a package recipe
decision before signing, never a deletion after installation.

## Primary apk references

The normative implementation is the pinned apk-tools source in
`distribution/sources.env`, especially `apk-package(5)`, `apk-mkpkg(8)`,
`apk-mkndx(8)`, `apk-world(5)`, and `apk-audit(8)`. Publication signs directly
through `mkpkg --sign-key` and `mkndx --sign-key`; there is no unsigned package
or index checkpoint waiting for a later signing pass.
