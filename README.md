# libqm-prototype

Post-link compilation of a Linux distribution: the kernel and each linked
x86-64 ELF are reduced to equivalent, smaller, ordinary executables, and the
result is booted and measured.

> Take an ordinary linked x86-64 program and obtain another ordinary x86-64
> program — the same complete machine behaviour, less machine computation, with
> the equivalence verified rather than assumed.

The distribution is the destination. The fixed `development-standard-v1`
profile names the Linux kernel, BusyBox, the C/Git/HTTPS toolchain and the
service graph. Every linked `ET_EXEC`/`ET_DYN` in that closure is post-link
compiled before its package is signed, each optimized ELF is independently
checked against its ordinary linked input, and the optimized packages are
assembled into one candidate root that actually boots. Publication then
requires a same-identity reduction in canonical release size and in paired
native execution. Native optimized x86 is the executable result.

The distribution is what Length³ OS ([`os/`](os/)) runs: `l3`
installs the release root on a device and opens a repo inside it, without
privilege, on the host's own kernel.

QM is the same quotient-and-minimum idea at the scale of a small C function:
it removes distinctions that no declared observer or future computation can
detect, then chooses the cheapest remaining physical representative — and
verifies the result.

```
C / C++  →  Clang -O2  →  semantics  →  quotient  →  normalized action
         →  minimum physical representative  →  verification

linked x86-64 ELF  →  post-link compiler  →  optimized ELF + proof
                                             `-> native execution
```

The grammar QM normalizes into is GF(2)-linear maps, convolutions, lane-local
steps, gathers, whole-word reductions and a bounded case analysis — so the
bit-manipulation exercises from CS:APP, MIT 6.172 and Princeton's *Algorithms*
are in the categorized `research/corpus/` alongside the lane kernels.

## Layout

* [`os/`](os/) — **Length³ OS**: the desktop app (Tauri), `l3`, and the Remote.
  It runs the distribution the compiler builds.
* [`compiler/`](compiler/) — the product: a C post-link compiler that reduces a
  linked x86-64 ELF (including the Linux kernel image) to an equivalent,
  ordinary, optimized ELF, and the release tooling. Start at
  [`compiler/README.md`](compiler/README.md); the compiler, its acceptance
  contract and remaining work are in
  [`compiler/postlink-compiler/`](compiler/postlink-compiler/), and the
  bootable-distribution contract and publication gates in
  [`compiler/docs/DISTRIBUTION.md`](compiler/docs/DISTRIBUTION.md).
* [`distribution/`](distribution/) — the end target, the fixed
  `development-standard-v1` distribution, assembled and booted as one root: its
  pinned sources, build host and build, with the profile, recipes and checks in
  [`distribution/packaging/`](distribution/packaging/).
* [`releases/`](releases/) — release notes, verification receipts and evidence.
  A receipt keeps the paths of the tree it was made from.
* [`research/qm/`](research/qm/) — the original research prototype.
  [`SPEC.md`](research/qm/SPEC.md) is the product specification;
  `qm-prototype-observation.py` is the solver study it came from, and
  `x86_oracle.py` is its native execution oracle.
* [`research/corpus/`](research/corpus/) — categorized C, assembly,
  physical-array, and VM kernels.
* [`xlat/`](xlat/) — static x86-64 Linux programs as WebAssembly, for the app in
  a browser.

`compiler/` is self-contained: it does not import from `research/qm/`.

## Quick start

The initial **OS Length3 Linux 0.1.0** stable native bundle is distributed as a
[GitHub Release asset](https://github.com/elysia090/libqm-prototype/releases/tag/os-length3-linux-v0.1.0).
See [release scope and verification](releases/native/RELEASE-0.1.0.md) and
[bootstrap trust / object delivery](compiler/docs/DELIVERY.md).
The previous RC and its receipts remain historical. The earlier browser VM
(its Web Release ZIP, what os.length3.com served then, and the qm.length3.com
UI) has been removed from this repository; its release asset stays on the
release page. os.length3.com is now the app in `os/` and its Remote
([os/README.md](os/README.md), Deploy).

The native products build and check as ordinary C:

```sh
cd compiler
make -j4                             # support, x86, postlink-compiler, artifact, ...
make check                           # the product-level suite
```

A single linked ELF is compiled through the post-link CLI described in
[`compiler/postlink-compiler/README.md`](compiler/postlink-compiler/README.md):

```sh
cc -static source.c -o input.elf
compiler/postlink-compiler/build/postlink-compiler input.elf -o output.elf
compiler/optimized-x86/build/postlink-verify input.elf output.elf
```

The distribution itself is assembled on the fixed Linux build host described in
[`distribution/README.md`](distribution/README.md):

```sh
cd distribution
./build.sh                           # profile, packages, post-link pass, root gate
```

## What it produces

For the 14-line `ranks8` from the spec:

```
Quotient Minimizer    2 core operations      PDEP ; IMUL
Residual freedom      502 solutions
Verification          exact exhaustive, 256 / 256
Artifact               2,148 bytes           pack(code(z))
```

The distribution result is a different comparison. It is reported only when
the complete fixed profile has been post-link compiled, proved, packaged, and
booted, and it names canonical release bytes and paired native execution
against the same fixed source identities. Until then the recipe reports its
verified inputs and stops; a tar, SquashFS extent or partial root is never
substituted for either result.
