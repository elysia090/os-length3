# Linux development distribution

> The implementation may be unusual; Linux semantics are not.

## Character

The distribution is small, fast, quiet, simple, predictable, inspectable, and
otherwise gets out of the way as ordinary Linux.

These are release properties rather than aesthetic claims:

* **small**: one 75 MB (75,000,000-byte) standard delivery bound, one identity for equal
  content, no unused executable payload, and no mandatory second artifact;
* **fast**: cold prompt within three seconds, demand-loaded cold tools, native
  x86 execution on native hosts, and no runtime decode or optimization path;
* **quiet**: no telemetry, discovery broadcast, automatic repository refresh,
  unsolicited network connection, periodic full-tree scan, background
  compaction, or idle write; only declared services remain alive;
* **simple**: ordinary ELF, syscalls, VFS, network stack, paths, users, files,
  and commands, with one compiler path and one storage authority;
* **predictable**: fixed source closure, immutable release root, compiled
  service DAG, explicit resource and network grants, deterministic publication,
  and atomic rollback;
* **inspectable**: `ps`, `ss`, `ip`, `nft`, `mount`, `lsblk`, `dmesg`,
  `s6-rc-db`, and `apk` expose the running state, while the terminal reports
  release/root identity, resource limits, admitted bytes, and service failures;
* **unobtrusive**: no host PATH injection, drive auto-mount, path translation,
  shell interception, proprietary guest command, or hypervisor vocabulary is
  required for normal work.

Quiet does not mean opaque. A requested package operation, network connection,
snapshot, or repair is explicit and observable; otherwise an idle workspace
does no work.

## Product contract

There is one Linux distribution and two execution projections. A release fixes
the kernel, package closure, service graph, optimized x86 ELFs, filesystem
root, and trust roots once. Native execution runs those x86 programs directly;
browser execution lowers the same accepted programs to bounded Wasm modules.
Changing the projection does not change `/usr`, the shell, package database,
workspace, or command behavior.

The product is a project-scoped development sandbox with an OS-quality user
experience. Opening a workspace gives a normal terminal, files, C toolchain,
Git and HTTPS. It does not inherit the host filesystem, host environment,
credentials, devices, or network reachability unless the user grants them.
Closing a workspace releases CPUs, RAM, workers, mappings, and plaintext cache;
only authenticated immutable roots and committed dirty workspace objects need
survive.

This is intentionally narrower and more direct than a general host
distribution, but more complete than a rescue image or build appliance.

## Standard 75 MB profile

The standard profile is one functional closure, not an accidental list of
binaries:

| responsibility | selected surface |
| --- | --- |
| kernel and libc | Linux, musl |
| rescue and early userland | BusyBox |
| PID 1 and service state | s6, s6-rc |
| device events | mdevd |
| package operations | apk-tools |
| kernel and mount administration | util-linux, kmod |
| network configuration | iproute2, dhcpcd, nftables, chrony |
| local filesystem maintenance | e2fsprogs |
| identities and privileges | shadow, libcap, acl, attr |
| authenticated network clients | OpenSSL, CA bundle, curl, Git, OpenSSH client |
| archives | tar, gzip, bzip2, xz, zstd, cpio |
| interactive essentials | tzdata, file, less, nano |
| C development | GCC C frontend, binutils, make, musl and Linux headers, pkg-config |

Existing useful recipe content remains unless it duplicates semantics rather
than command names. BusyBox stays as the early and recovery surface even when a
full utility later owns the ordinary interactive command. The provider of each
required command is fixed by the profile checker.

The published standard release must be at most 75,000,000 canonical artifact
bytes after every linked ET_EXEC/ET_DYN has become a proved optimized ELF. The
unit is the emitted canonical program word derived in `ARTIFACT.md`, not a
filesystem walk, tar extent, SquashFS extent, or storage pack. The earlier
114,573,312-byte figure was the clean SquashFS backing used by a deprecated
machine-pack route; it was neither this complete package recipe nor an
Artifact measurement and is not a release-size result.

The current build deliberately reports no standard-release size. It first
assembles the exact profile, checks command providers, resources, runtime
closure and every ELF proof, and then stops with `canonical artifact
publication: not connected`. A tar size or a partial candidate root can never
turn that red gate green. The first publishable size measurement is emitted
only after the complete recipe passes and the Artifact writer emits (1).

The standard profile fixes the nonempty Artifact semantic-family mask to all
six families: block, pure slice, instruction meaning, immutable read, archive
member, and derived proof/coordinate/directory cell. The complete gate must
observe exactly that mask. Omitting a population is therefore a publication
failure rather than a smaller release.

Let `z_release` be the one finite-support artifact image containing selected
optimized x86 programs, total finite-function generators and exact residuals,
the initial persistent cut, canonical filesystem semantic bytes, package and
service manifests, and trust roots. Equal semantic objects have one rank before
`z_release` is emitted. Its one self-delimiting spelling is:

```text
release_word = E(bit_length(z_release)) || z_release
standard_release_size = ceil(bit_length(release_word) / 8).          (1)
```

Linux remains responsible for pathname, inode, hard-link, xattr and filesystem
metadata semantics. Artifact identity sees the resulting canonical filesystem
extent as semantic bytes and applies the immutable-memory quotient and selected
total address generator from `ARTIFACT.md`; storage never invents a second path
serialization. Bytes already named by that filesystem extent are referenced,
not copied again into boot RAM or executable-resource pages.

`STORAGE.md` then projects this exact identity through page quotienting,
predictor/residual encoding, optional compression, framing, encryption, erasure
coding and rank-addressed delivery. Those bytes are reported separately as
`release.transfer_bytes`, together with authentication and parity overhead.
Changing that projection cannot change (1). Native supervisor code, browser
runtime/UI, WebTransport relay, x86-to-Wasm compiler, and object-store protocol
code are projection machinery outside the distribution and are reported
independently.

Debug information, tests, manuals, locales other than the chosen baseline,
GCC LTO programs, language ecosystems, server daemons, and package download
caches are optional cold packages and are not charged to the standard profile.

The limit is not met by hiding bytes in a second mandatory artifact. It covers
all distribution objects required for cold boot through an interactive shell,
the standard service state, C compile/run, Git/HTTPS, archive operations, and
package-index inspection. Optional repositories are fetched only after an
explicit package operation.

## Boot and service normal form

PID 1 owns one compiled s6-rc service DAG. Service definitions are build input;
the compiled database is immutable release content and is verified before
publication. Boot is a state transition, not an ordered directory of shell
scripts.

The initial graph is:

```text
mount-api-filesystems
        |
        v
      mdevd-ready ---> coldplug
        |                 |
        +--------+--------+
                 v
       root-and-workspace-ready
             /       \
            /         \
           v           v
interactive-ready   firewall-base-policy
                          |
                          v
                    network-adapter
                          |
                          v
                       dhcpcd
                          |
                          v
                    network-ready
                          |
                          v
                      chronyd
                          |
                          v
                    time-synced
```

`interactive-ready` depends only on local filesystems and device readiness.
Airplane mode, an absent network grant, a missing DHCP server, or failed clock
synchronization cannot delay the prompt or local `cc`, `make`, and `git status`.
The network branch exists only when a network capability is attached.
`network-ready` means that the firewall policy is active and the granted
adapter has usable addressing; it does not mean that NTP succeeded.
`time-synced` is a later, independent milestone, so a failed NTP peer cannot
make `curl` or `ssh` report that the network itself is unavailable.

Machine creation supplies exactly one `clock_boot(realtime_ns,
uncertainty_ns, source, generation)` hardware event. Linux initializes its RTC
from that event and owns all guest clock semantics thereafter. The monotonic
clock begins at zero and never moves backward; realtime initially advances from
the boot sample. Native obtains the sample from its RTC supervisor, browser
from its explicit clock adapter, and replay uses the recorded event. `chronyd`
may discipline Linux time after networking but is never a prerequisite for the
offline prompt or `network-ready`.

Only `mdevd`, supervision, granted networking, and an active terminal need be
long-running. Compiler, package manager, Git, SSH clients, repair tools, and
editors are cold executables. Every oneshot is idempotent, has an explicit
timeout, and either reaches its declared state or leaves a retryable state.
s6-rc's compiled dependency database, transition failure, and atomic database
update model are therefore part of the acceptance contract, not merely an init
implementation choice.

## Filesystem and package state

Linux owns the VFS. The execution adapter exports block/page operations; it
does not implement a second pathname cache or package filesystem.

The complete package-state and publication contract is derived in
[`PACKAGE.md`](PACKAGE.md). Package roots remain distinct until they have been
post-link compiled, packaged, signed, and installed. A merged raw root is only
an analysis population and can never pass the release gate.

```text
authenticated immutable release lower
          + committed workspace/config COW upper
          + volatile /run and /tmp
          -> one ordinary Linux mount namespace
```

ELF transformation occurs before package publication, never after install:

```text
upstream source -> ordinary per-package build -> linked package roots
                -> release-wide post-link schedule -> optimized package roots
                -> proof -> signed apk mkpkg -> signed apk mkndx

signed optimized packages -> offline apk transaction -> candidate root
                          -> installed-db/ownership/audit/closure gates
                          -> authenticated root manifest
                          -> atomic current-root switch.                (2)
```

The release root is immutable and names exactly the standard package closure.
Each workspace separately names a `system-root`, initially the release root.
A client-side `apk add` only combines already published bytes; it never invokes
the optimizer. A successful transaction validates a candidate and atomically
advances that workspace's `system-root`; failure leaves the prior value current
and never changes the release identity. Thus `release=1.0` remains a stable
statement while `system-root=sha256:...` precisely identifies user additions.

The package signature, installed database, ELF proof, and candidate root all
name the same final byte string. Package signatures express repository policy,
while the artifact root expresses the exact installed system. Neither local
disk, browser storage, CDN, object store, nor package mirror is trusted with
plaintext authority.

The signed `release-metadata` package carries one canonical runtime-closure
manifest for the exact package set. It names absolute in-root consumers and
targets for dependencies that ELF metadata cannot prove: `dlopen()` modules,
GCC `cc1`/`as`/`ld`, Git helpers, shell-discovered execs, OpenSSL providers,
service executables, triggers, configuration and other runtime resources.
Publication cross-checks each endpoint against its installed apk owner.
Keeping one canonical union avoids a fixed sidecar in every small package;
the signed package set and exact world still bind the manifest atomically.
`DT_NEEDED` scanning remains mandatory but is only one input to closure.
Undeclared string-discovered execution is a package publication failure, not a
runtime search fallback.

The workspace is a separate named root. OS rollback never rolls project data
back accidentally, and exporting a project never drags the immutable system
image with it. Native host directories are absent by default and enter through
explicit grants, preferably idmapped mounts. Browser uploads and cloud objects
enter through the same named-resource boundary.

## One Linux authority in both projections

The browser does not implement Linux syscalls, pathname resolution,
permissions, processes, credentials, signals, sockets, clocks, or package
semantics in JavaScript, Wasm glue, or the delivery adapter. Native optimized
ELFs enter a compatible host Linux kernel directly; translated browser programs
enter the release Linux kernel. Linux, rather than a projection adapter, is the
sole authority for VFS, process, credential, signal, socket, and time semantics
in both cases.

```text
                  same accepted x86 program
                           |
              +------------+-------------+
              |                          |
       native CPU execution        x86-to-Wasm body
              |                          |
       host Linux kernel          release Linux kernel
              |                          |
              +----- Linux ABI semantics-+
                           |
                 VFS / process / network
```

The native launcher supplies isolation and resource policy, not syscall
semantics. The browser VM supplies CPU, RAM, MMU, interrupt and virtio machine
mechanics, not a POSIX compatibility layer. The native host kernel must pass the
release Linux-ABI acceptance test; the browser release kernel must pass the same
guest test. A JavaScript or native userspace syscall fallback is a release error.

## CPU and ELF contract

`x86-64-v2` is the standard release's human-facing CPU level, not its normative
definition. The normative `development-standard-v1` record is the exact table
below; every unlisted leaf, subleaf and bit is zero.

| surface | exact value |
| --- | --- |
| CPUID.0 EAX/EBX/ECX/EDX | `00000007 756e6547 6c65746e 49656e69` |
| CPUID.1 EAX/EBX/ECX/EDX | `000306a9 00000000 00982201 07808139` |
| CPUID.7.0 EAX/EBX/ECX/EDX | `00000000 00000000 00000000 00000000` |
| CPUID.80000000 EAX | `80000008` |
| CPUID.80000001 ECX/EDX | `00000001 20100800` |
| CPUID.80000008 EAX | `00003028` |
| XCR0 / XSAVE | not exposed; CPUID.0d is zero and XGETBV/XSETBV are `#UD` |
| CPU-derived auxv | `AT_HWCAP=07808139`, `AT_HWCAP2=0`, `AT_PLATFORM=x86_64`, `AT_PAGESZ=4096`, `AT_CLKTCK=100` |

The CPUID words include the x86-64 psABI baseline and CMPXCHG16B, LAHF/SAHF,
POPCNT, SSE3, SSSE3, SSE4.1 and SSE4.2. CR4.OSFXSR is required; AVX, XSAVE,
OSXSAVE, RDRAND and RDSEED are deliberately absent. Address-, image-, random-
and credential-valued auxv entries remain per-exec bindings, but cannot expose
a second CPU feature channel. GCC defaults, instruction admission, native
execution, browser execution and diagnostic reporting include the same `x86/profile.h`
record. A mismatch is a publication failure.

ELF admission is total and occurs before package signing:

```text
e_machine == EM_X86_64
and accepted System V ABI and relocation model
and every decoded instruction is within x86-64-v2
and PT_INTERP is absent or names the accepted in-root interpreter
and DT_NEEDED plus the declared runtime manifest form a closed in-root graph
and every executable mapping is valid and has a proved post-link image.    (3)
```

Native admission rejects a host whose required feature set is incomplete and
the process launcher prevents host-only features from becoming package input.
The browser compiler rejects instructions outside the same record. Therefore
an accepted packaged ELF cannot run natively and later fail in the browser
because the package silently depended on a different CPUID surface.

## Native resource manager

The native product is a direct Linux process sandbox, not a virtual machine.
Its contract is smaller and more predictable than host-integration layers such
as WSL:

* accepted optimized x86 ELFs execute directly on the host CPU;
* the compatible host Linux kernel remains the syscall, VFS and process
  authority; no userspace POSIX or syscall emulation is introduced;
* demand-mapped authenticated objects and page faults supply clean memory;
* cgroup v2 supplies explicit CPU, memory, process and I/O budgets;
* user, mount, PID, network and cgroup namespaces remove ambient host scope;
* Landlock can only reduce filesystem rights inherited by native helpers;
* seccomp reduces each helper's syscall surface but is never treated as the
  sandbox by itself;
* TAP/virtio is the native network adapter; the browser substitutes the
  WebTransport virtual-NIC adapter defined in `NETWORK.md`.

Lifecycle verbs have deliberately different persistence cuts. Native suspend
uses ordinary process freezing and reconstructible mappings rather than vCPU
state; the browser machine retains the corresponding architectural cut:

* `suspend` retains dirty process/machine memory, the minimal execution and
  device/timer state required by the projection, and the workspace generation.
  It evicts every clean mapping and executable projection that can be
  reconstructed. `resume` continues the exact execution, including the
  existing shell process.
* `close` commits workspace/config objects and discards all process or machine
  state. A later `open` starts the same release and attaches the same workspace;
  it does not claim process continuation.
* `snapshot` publishes a complete named suspend cut. `restore` creates a new
  generation from it and never accepts acknowledgements from the old one.

The supervisor API is consequently small:

```text
create(root, workspace, grants, resources, network_policy)
start | suspend | resume | snapshot | restore | destroy
attach_terminal | attach_file | publish_workspace
```

Every handle is scoped to one workspace generation. Closing the last handle
discards all machine state after the workspace commit. Old acknowledgements,
leases, network frames, and storage publications cannot cross a generation.

## User experience

Browser and native surfaces share the same four nouns: Editor, Run, Files, and
Terminal. Native does not expose hypervisor terminology during ordinary use.
The expected first session is:

```text
open workspace
  -> prompt ready
  -> edit or clone
  -> make -j
  -> run/test
  -> close
  -> later open the same workspace
```

Resource budgets and grants are visible before execution and can only become
more permissive through a user action. Boot progress reports authenticated
bytes fetched, pages admitted, and the current service milestone; it does not
present compiler-internal block or quotient vocabulary.

## Publication gates

A standard release is rejected unless all of the following are green:

1. every upstream input and service source has a fixed digest;
2. the compiled service DAG is acyclic and `default` reaches the declared
   interactive state;
3. every package passes the metadata, dependency, signature, exact-world,
   installed-database, script/trigger-effect, and filesystem-ownership gates in
   `PACKAGE.md`; there is no unowned persistent release path;
4. every required command, shebang interpreter, ELF interpreter, `DT_NEEDED`
   object and every package-declared `dlopen`, helper, exec, provider, service,
   trigger, configuration and non-command resource resolves inside the
   candidate system root;
5. every linked x86-64 ELF satisfies the CPU and ELF contract, is optimized before its package is
   signed, and is independently proved against its ordinary linked input;
6. no runtime decoder, interpreter, Python/JavaScript execution route, LTO
   payload, test corpus, build cache, documentation, or package cache remains;
7. the canonical artifact reader reproduces the single word and every total
   generator/exact residual, and `standard_release_size` in (1) is at most
   75 MB (75,000,000 bytes); the identity-preserving storage projection reports
   `release.transfer_bytes` separately;
8. offline cold boot reaches a shell and C compile/run, `make -j`, `git status`,
   package inspection, and archive round-trip succeed; with a network grant,
   Git/HTTPS, SSH client and address configuration succeed at `network-ready`,
   while clock sync is tested separately at `time-synced`;
9. suspend/resume proves exact process continuation after clean-page eviction,
   while close/open proves a cold machine with the same committed workspace;
10. native and browser report the same distribution identity and pass the same
   guest acceptance script.

## Primary references

* [s6-rc overview](https://skarnet.org/software/s6-rc/overview.html) and
  [s6-rc-compile](https://skarnet.org/software/s6-rc/s6-rc-compile.html)
* [mdevd](https://skarnet.org/software/mdevd/mdevd.html)
* [apk-tools](https://gitlab.alpinelinux.org/alpine/apk-tools)
* [apk v3 package/index tool documentation](https://wiki.alpinelinux.org/wiki/Apk/apkv3_doc_diff)
* [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
* [Linux Landlock](https://docs.kernel.org/userspace-api/landlock.html)
* [Linux seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html)
* [Linux OverlayFS](https://docs.kernel.org/filesystems/overlayfs.html)
* [x86-64 psABI micro-architecture levels and auxv](https://gitlab.com/x86-psABIs/x86-64-ABI/-/blob/master/x86-64-ABI/low-level-sys-info.tex)
