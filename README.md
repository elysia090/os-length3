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

The distribution is what Length³ OS ([`src/desktop/`](src/desktop/)) runs: `l3`
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
are in the categorized top-level `corpus/` alongside the lane kernels, and what
QM makes of each of them is in [`src/v2/README.md`](src/v2/README.md).

## Contents

| path | what it is |
| --- | --- |
| [`src/v2/`](src/v2/) | the post-link compiler and release tooling over one Linux distribution identity |
| [`src/desktop/`](src/desktop/) | **Length³ OS**: the desktop app, `l3`, and the Remote |
| [`xlat/`](xlat/) | static x86-64 Linux programs as WebAssembly, for the app in a browser |
| [`src/v2/postlink-compiler/`](src/v2/postlink-compiler/) | the x86-64 post-link compiler, its acceptance contract and remaining work |
| [`src/v2/docs/DISTRIBUTION.md`](src/v2/docs/DISTRIBUTION.md) | the bootable-distribution contract and publication gates |
| [`data/distribution/`](data/distribution/) | the fixed `development-standard-v1` profile, recipes and checks |
| [`src/v1/SPEC.md`](src/v1/SPEC.md) | the original product specification |
| [`src/v1/`](src/v1/) | the original research prototype and its x86 execution oracle |
| [`corpus/`](corpus/) | categorized C, assembly, physical-array, and VM kernels |

## Quick start

The initial **OS Length3 Linux 0.1.0** stable native bundle is distributed as a
[GitHub Release asset](https://github.com/elysia090/libqm-prototype/releases/tag/os-length3-linux-v0.1.0).
See [release scope and verification](artifact/native/RELEASE-0.1.0.md) and
[bootstrap trust / object delivery](src/v2/docs/DELIVERY.md).
The previous RC and its receipts remain historical. The earlier browser VM
(the Web Release ZIP, os.length3.com and the qm.length3.com UI) has been
removed from this repository; its release asset stays on the release page.

The native products build and check as ordinary C:

```sh
cd src/v2
make -j4                             # support, x86, postlink-compiler, artifact, ...
make check                           # the product-level suite
```

A single linked ELF is compiled through the post-link CLI described in
[`src/v2/postlink-compiler/README.md`](src/v2/postlink-compiler/README.md):

```sh
cc -static source.c -o input.elf
src/v2/postlink-compiler/build/postlink-compiler input.elf -o output.elf
src/v2/optimized-x86/build/postlink-verify input.elf output.elf
```

The distribution itself is assembled on the fixed Linux build host described in
[`data/README.md`](data/README.md):

```sh
cd data
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
