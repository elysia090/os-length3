# v2 products

The system has one compiler product and two execution/delivery products over
one canonical Linux distribution identity:

1. `postlink-compiler`: a native CLI that accepts a linked x86-64 ELF and
   emits a smaller, independently runnable optimized x86-64 ELF.
2. native: the optimized kernel and user ELFs run directly. Its delivery
   adapter may exploit native `mmap`, page faults, NUMA, asynchronous I/O,
   process lifetime, and ordinary network devices.
3. `vm` + `web`: the same optimized ELFs are lowered by a VM-internal backend
   and run in the browser. Its delivery adapter uses authenticated page faults,
   dirty COW, Worker lifetime, browser persistence, and a virtual NIC.

The Linux kernel, root filesystem, POSIX/C/git/HTTPS toolchain, object
identities, and authenticated root form one canonical distribution. A release
publishes native and browser delivery projections of that root; it does not
build two semantically independent distributions. Wasm modules are derived
browser execution objects, never the canonical program identity.

The native profile is a development sandbox, not a second conventional host
distribution. It presents the same shell, files and workspace lifecycle as
the browser profile, while executing accepted optimized ELFs directly on the
host CPU under a compatible Linux syscall boundary. Native `mmap`, page faults,
namespaces, cgroup v2, asynchronous I/O and ordinary devices manage the same
authenticated objects. It has no CPU-virtualization or KVM dependency. Opening
a workspace yields an immediately usable Linux environment; closing it retains
only its immutable root and committed workspace/config objects. Backend and
cache policy are implementation details, not different user environments.

The release-size gate applies to that shared distribution after every linked
ET_EXEC/ET_DYN has been replaced by its independently runnable optimized ELF.
The current unoptimized SquashFS transfer baseline is 114,573,312 bytes.
Publication targets at most 75 MB (75,000,000 bytes) of unique, logical,
uncompressed canonical kernel/boot/root payload. Transfer bytes are a second
metric; filesystem compression, a separate machine pack, or an unoptimized
toolchain image cannot satisfy the primary gate on its behalf.

The historical machine-artifact normalization reduced the former
405,847,385-byte materialized pack to a 115,430,431-byte program word.  That
number must not be reported as the distribution's storage coefficient.  Its
137,510,610-byte directory-bearing pack still opens a separate
114,575,792-byte SquashFS delivery.  Including the 1,888 fixed root bytes, its
actual binary cold-delivery closure is therefore 252,088,290 bytes.  The web
loader now requires and checks that complete transitive extent instead of
silently reporting only the first pack.  None of these four historical
`linux-x86-64`, machine-pack, merged-toolchain, or SquashFS projections is named
by the production artifact catalog; a current distribution cannot fall back
to them while the fixed recipe is being rebuilt.

This exposes the old double route rather than legitimizing it: the pack keeps
115,430,431 bytes of module/parameter/state/edge/entry execution graph while
the filesystem payload is delivered again as its backing.  The production
route replaces every linked ELF in the fixed approximately 323.3 MB
unoptimized unique-file population with the ordinary optimized ELF, then
publishes the resulting canonical release exactly once.  Its storage
coefficient is `optimized canonical release / source canonical release`; a
machine pack, SquashFS extent, Wasm cache, or transfer compression cannot be
used as either side of that ratio.  The target remains at most 75,000,000
canonical bytes before a replaceable Storage projection.

Storage and networking are adapter boundaries shared by both profiles. They
authenticate, fetch, cache, evict, recover, and synchronize physical objects,
but do not acquire CPU, MMU, VFS, or x86 semantics. The Linux kernel remains
the sole owner of VFS, process, credential, signal, socket, and time semantics:
the compatible host kernel in native execution and the release kernel in the
browser machine. The browser has no POSIX/syscall fallback.

The normative standard-profile, service, sandbox, and lifecycle contract is
[DISTRIBUTION.md](docs/DISTRIBUTION.md). Package metadata, dependency,
ownership, script/trigger, signing, installation, and audit policy is
[PACKAGE.md](docs/PACKAGE.md). Together they define one 75 MB development
distribution shared by native and browser execution.

The one production path is:

```text
linked x86 ELF
    -> postlink-compiler
    -> optimized x86 ELF + proof
    |-> native execution + native delivery adapter
    `-> wasm-compiler (VM-internal)
         -> ordinary Wasm modules
         -> vm.wasm + browser delivery adapter
         -> browser execution
```

The optimized program is still an ordinary x86 ELF. Its proof is carried by
standard ELF mechanisms and is independently checkable. There is no private
execution container, decoded-instruction stream, Python executor, JavaScript
instruction reader, STEP fallback, or runtime decoder.

## Source tree

```text
src/v2/
├─ support/
│  ├─ include/support/
│  │  ├─ types.h
│  │  ├─ arena.h
│  │  ├─ checked.h
│  │  ├─ future.h
│  │  └─ sha256.h
│  └─ src/
├─ x86/
│  ├─ include/x86/
│  │  ├─ elf.h
│  │  ├─ decode.h
│  │  ├─ semantics.h
│  │  └─ fault.h
│  └─ src/
├─ optimized-x86/
│  ├─ include/optimized-x86/
│  │  ├─ format.h
│  │  ├─ reader.h
│  │  └─ proof.h
│  ├─ src/
│  └─ cli/main.c            postlink-verify
├─ postlink-compiler/
│  ├─ include/postlink/compiler.h
│  ├─ src/
│  ├─ cli/main.c
│  └─ check/
├─ machine-abi/
│  ├─ include/machine/
│  │  ├─ state.h
│  │  ├─ event.h
│  │  ├─ barrier.h
│  │  └─ result.h
│  └─ src/
├─ wasm-compiler/
│  ├─ include/wasm-compiler/compiler.h
│  ├─ src/
│  ├─ cli/main.c
│  └─ check/
├─ artifact/
│  ├─ include/artifact/
│  │  ├─ root.h
│  │  ├─ object.h
│  │  ├─ index.h
│  │  ├─ future.h
│  │  ├─ program.h
│  │  ├─ share.h
│  │  ├─ payload.h
│  │  ├─ derive.h
│  │  └─ resource.h
│  ├─ src/
│  ├─ cli/
│  └─ check/
├─ storage/
│  ├─ include/storage/
│  │  ├─ identity.h
│  │  ├─ delivery.h
│  │  ├─ compression.h
│  │  ├─ crypto.h
│  │  └─ erasure.h
│  ├─ src/
│  ├─ cli/
│  └─ check/
├─ vm/
│  ├─ include/vm/
│  │  ├─ machine.h
│  │  ├─ memory.h
│  │  ├─ mmu.h
│  │  ├─ device.h
│  │  └─ lifecycle.h
│  ├─ core/
│  ├─ wasm/
│  └─ check/
└─ web/
   ├─ runtime/
   ├─ worker/
   └─ ui/
```

Directories are product or library boundaries, not historical phases. A
source file belongs to the lowest layer whose public contract is sufficient to
explain it. Repository-only generators and checks live with the product they
exercise; there is no global catch-all `tools/` or `tests/` ownership boundary.

## Allowed dependencies

```text
support
   ├──▶ x86
   ├──▶ optimized-x86
   ├──▶ machine-abi
   ├──▶ artifact
   └──▶ storage

x86 + optimized-x86
          │
          ▼
 postlink-compiler

optimized-x86 + machine-abi
          │
          ▼
    wasm-compiler

machine-abi + artifact + storage
          │
          ▼
          vm
          │
          ▼
         web
```

An arrow means “may include or link”. Reverse edges are build failures.
Notably:

- `postlink-compiler` does not know Wasm, VM layout, browser delivery, or the
  artifact store.
- `wasm-compiler` reads only the accepted optimized ELF and the machine ABI; it
  never re-decodes the linked input.
- `vm` executes the machine ABI and faults immutable objects through
  `artifact` and `storage`; it does not link either compiler.
- `web` owns orchestration and presentation only. It does not implement x86,
  MMU, VFS, or artifact semantics in JavaScript.

## Product contracts

The ordinary compiler produces a linked x86 ELF. The standalone post-link CLI
accepts that ELF and emits another independently runnable x86 ELF. Publication
requires a proof of total coordinate coverage, exact fault cuts, the fixed
machine ABI, direct control, and improved cost. The proof is bound to the ELF
build identity; absence or mismatch is a compile error.

The standalone Wasm compiler accepts only a proved optimized x86 ELF and emits
ordinary bounded Wasm modules. The VM imports those modules lazily into its
function table and provides CPU state, RAM, MMU, events, devices, and lifecycle.
Missing code is rejected before publication rather than interpreted at run
time.

The Playground is a thin invocation of the same products:

```text
source file
    -> ordinary compiler and linker
    -> linked x86 ELF
    -> postlink-compiler
    -> optimized x86 ELF + proof
    -> VM
    -> Run terminal
```

There is no Playground-only language runtime. A source with `main` follows this
path and executes; a source without `main` follows the same compile path and
reports the accepted functions and proof without inventing an execution entry.

Artifact identity and delivery are separate. `artifact` defines authenticated
roots, objects, indexes, and resources. `storage` defines content identity,
compression, encryption, erasure coding, and untrusted delivery locations.
Neither subsystem gives storage tiers semantic authority.

The derivations and invariants are normative in:

- [POST-COMPILE.md](docs/POST-COMPILE.md)
- [ARTIFACT.md](docs/ARTIFACT.md)
- [STORAGE.md](docs/STORAGE.md)
- [NETWORK.md](docs/NETWORK.md)
- [DISTRIBUTION.md](docs/DISTRIBUTION.md)

## Deletion rule

Compatibility is not a product boundary. When an implementation is replaced,
its reader, writer, runtime route, tests, generator, manifest entry, and
documentation are removed together. New work must not reintroduce `qm/`, the
Python kernel, Python VM modules, Pyodide, decoded-block execution, or a second
artifact reader.
