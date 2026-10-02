# postlink-compiler

`postlink-compiler` is the standalone C product between an ordinary linker and
all execution backends. A self-contained static `ET_EXEC` needs no retained
code relocations. Dynamic inputs retain construction evidence with
`--emit-relocs`; the ordinary optimized output does not retain it:

```text
source -> ordinary compiler/linker -> linked x86-64 ELF
                                      |
                                      v
                              postlink-compiler
                                      |
                                      v
                         optimized x86-64 ELF
                            /                 \
                    native execution      wasm-compiler
                                                |
                                                v
                                             vm.wasm
```

This compiler is applied to the whole distribution, not only to a single
program: the repository's goal is the fixed `development-standard-v1` kernel
image and every linked `ET_EXEC`/`ET_DYN` in its package closure compiled after
linking into equivalent, ordinary optimized ELFs before their packages are
signed, assembled into one root that boots and is measured for canonical size
and paired native execution. That end-to-end obligation is fixed by
[`../docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md) and
[BENCHMARK.md](BENCHMARK.md); this file describes the compiler itself.

The output is an ordinary independently runnable `ET_EXEC` or `ET_DYN` file.
Its runtime meaning exists only in standard x86 program segments. Proof values
are global absolute symbols in `SHT_SYMTAB`; one GNU build-id authenticates the
complete output. There is no `.postlink.program`, sidecar, STEP stream, runtime
decoder, Python route, JavaScript reader, or VM-specific container.

Minimum selection is global over the emitted ordinary ELF. A complete
self-delimiting program space and transactional universal evaluator may be used
to enumerate and eliminate construction candidates, but both are compiler
proof machinery. The measured objective is native dependency span, native
physical work, exact final ELF bytes, and canonical ELF-byte rank. The length
of the generator is not the result, and no generator, codec, search frontier,
closure table, or evaluator survives in the ELF.

The normative contract is [CONTRACT.md](CONTRACT.md). Executable artifact
identity and delivery are separate responsibilities described by
[`../docs/ARTIFACT.md`](../docs/ARTIFACT.md) and
[`../docs/STORAGE.md`](../docs/STORAGE.md).
The fixed size and native-time comparison boundary is
[BENCHMARK.md](BENCHMARK.md).

## Current gate

The C frontend closes every executable byte coordinate as direct semantics, an
exact architectural fault, or an exact terminal event. Separately, the product
derives a finite native entry set from standard ELF construction evidence and
closes direct successors into block boundaries without retaining decoded rows.
The product CLI writes that finite population into one compact executable
`PT_LOAD`, removes proved identity instructions, rebinds direct control and
RIP-relative fields, rewrites affected static relocations, dynamic relocation
addends, dynamic symbols and `DT_INIT`/`DT_FINI`, and seals the result as an
ordinary proved ELF. The gate rejects missing construction evidence for a
dynamic input, an unresolved moved reference, a non-improving native objective,
a non-smaller file, or a proof mismatch. Checked static and dynamic fixtures
both execute directly after verification.

Local block and slice selections are only alternatives for the whole-ELF
constructor. They are not accepted independently: sharing, observable entry
addresses, veneers, dispatch, retained immutable ranges, segment layout,
alignment and proof metadata can change the global optimum. Publication is
allowed only after the complete emitted ELF wins that combined objective and
the remaining universal search cells are proved unable to beat it.

Earlier sealing-only size and timing observations are development history, not
the production comparison. Distribution publication remains red until the
fixed complete recipe records a smaller ordinary optimized root and a real
paired native improvement without changing behavior. Static work/span is a
non-regression certificate, not a timing claim. The current dynamic fixture is
19,528 -> 13,680 bytes and the freestanding relocation fixture is
9,128 -> 5,496 bytes; neither fixture is presented as the distribution ratio.

## Build and check

The C tools and instruction-level checks build with a native toolchain and GNU
make. From this directory on x86-64 Linux, with GCC or Clang and the pinned
Zydis submodule initialized:

```sh
git submodule update --init --recursive
make -j4
make check
```

## Source boundaries

The public product API remains `include/postlink/compiler.h`; private source
modules do not introduce another output format or runtime dependency.

| Source | Responsibility |
| --- | --- |
| `discover-entry.c`, `jump-table.c` | Prove execution entries and indirect targets from ELF evidence |
| `instruction-semantics.c`, `form-block.c` | Exact instruction laws and barrier-bounded SSA composition |
| `normalize-ssa.c`, `sweep.c` | Algebraic substitution and dependency-ordered normalization |
| `compile-elf.c` | Reachable entry closure and whole-ELF construction |
| `layout-elf.c`, `relocate-elf.c`, `emit-x86.c` | Layout, reference rebinding, and ordinary ELF output |
| `selection/encoding.c`, `selection/source.c` | Native encodings and source-field ownership |
| `selection/operands.c`, `expressions.c`, `flags.c`, `select-rules.c` | Operand, width, generation and flag laws |
| `selection/*-frame.c`, `handoff.c`, `lea.c` | Matching frame productions and their emitted spelling |
| `selection/tree-measure.c`, `tree-write.c`, `shared-dag.c` | Expression construction and shared-value scheduling |
| `selection/projection.c`, `candidates.c`, `select.c` | Exact emitted work/span, future projection, Pareto quotient, and selection orchestration |

These are independent translation units, not source-file includes. Cross-module
helpers have private `pl_select_` names and module headers; `shapes.h` contains
only the selection grammar's value types. Selection scratch is caller-owned;
there is no process-global mutable cache, epoch or retained source pointer.
The static archive is rebuilt with the exact current object population, so a
renamed or removed translation unit cannot survive as a stale archive member.
Native GCC parity enumerates nested translation units as well as top-level ones.

```sh
make selector-reentrancy-check  # independent images and caller arenas
make selection-policy-check    # 20000 candidate families and bounded metadata
make compiler-boundaries-check # reject misaligned or short public workspaces
make source-layout-check       # no unlisted C sources or duplicate archive members
make sanitizer-check           # ASan + UBSan, including decoder/ELF dependencies
make thread-sanitizer-check    # TSan; concurrent selection against serial bytes
```

Sanitizer runs use a disposable independent build tree; they do not replace
production libraries or distribution checkpoints. `support` also tests arena
alignment, capacity, NULL, and integer-limit behavior. GCC sanitizer runtimes
and POSIX threads are test dependencies only, not dependencies of the compiler
library or the shipped distribution.

## Execution and platform checks

`shift-width-check` and the other instruction checks execute the emitted x86 on
the build CPU and compare its values and defined flags with the source
instructions and an independent C reference. They use writable pages only
during construction, then make them read/execute. A Windows host can run the
same Makefile with MSYS2 UCRT64 GCC and GNU Make by passing an explicit shell
and compiler:

```powershell
$env:PATH = 'C:\msys64\ucrt64\bin;C:\msys64\usr\bin;' + $env:PATH
make -j4 SHELL=C:/msys64/usr/bin/bash.exe CC=C:/msys64/ucrt64/bin/gcc.exe AR=C:/msys64/ucrt64/bin/ar.exe all select-x86-check shift-width-check normal-form-check physical-check quotient-check instruction-law-check
```

Full ELF workload and distribution comparisons additionally need the fixed
Linux build environment described in [`../../../data/README.md`](../../../data/README.md);
a host-tool check is not a distribution benchmark. Keep disposable fixture
inputs and reports out of tracked paths.

```sh
make
make check
make native-benchmark

cc -static source.c -o input.elf
# Dynamic input: cc -Wl,--emit-relocs source.c -o input.elf
build/postlink-compiler input.elf -o output.elf
../optimized-x86/build/postlink-verify input.elf output.elf
build/native-benchmark input.elf output.elf argv0 [arguments...]

make production-benchmark-check \
  SOURCE_ROOT=/path/to/unoptimized-release \
  OPTIMIZED_ROOT=/path/to/optimized-release \
  BENCHMARK_REPORT=/path/to/comparison
```

The native measurement binary owns the 401-pair and eight-warm-up constants;
they are not caller parameters. The production target additionally owns the
workload population in `data/distribution/postlink-workloads.tsv`, records its
digest and the source/profile locks, measures both complete canonical roots,
and refuses a non-shrinking payload or a regressing weighted aggregate.

`make check` covers the public CLI, standard-ELF proof round trip, finite native
entry and block closure, exact x86 semantic witnesses, scalar residual-state
cut and physical-region normalization. Its current ELF fixture closes 49
native boundaries over 72 source instructions and measures 98 -> 71 physical
work and 86 -> 50 span. These are static fixture measurements, not elapsed-time
claims. The linked-image completeness gate is explicit:

```sh
make linked-completeness-check X86_IMAGE=/path/to/linked.elf
```

The library core is freestanding and allocation-free. The caller supplies
input, output and measured workspace. Only CLI/check programs use libc.

The release publisher may call `postlink_compile_observed`.  It is the same
compilation and the same ordinary-ELF output, with ephemeral callbacks for
every block control shell, pure-slice topology, parameter row, successor and
source instruction law.  A law is formed by one-instruction physical-SSA
normalization, so alternate encodings do not retain an opcode-byte identity.
The callbacks cover exactly
`native_blocks`/`native_source_instructions`; omission or callback failure is a
compile error.  After the optimized-ELF reader and proof gate succeed, the
commit callback receives the final ordinary ELF bytes in the same transaction;
there is no second artifact reader or publisher-side reconstruction path.  No
observation is a sidecar.  Immediately before commit, the observer also
receives each dense block state's final file span after relocation and proof
sealing.  These spans partition the compact code interval, including empty
erased bodies, so their file coordinates are generated prefix sums rather than
a retained table.  The Artifact composition check uses these callbacks
directly and proves that two identical 59-state ELF graphs add no second future
population, then exactly factors and reconstructs both committed ELF images.

## Next native step

The next transformation changes runtime bytes rather than attaching another
description of them:

1. replace every retained stateful source instruction sequence with selected
   native physical-SSA emission, rather than merely preserving valid source
   x86 after identity removal;
2. extend the compile-time metadata walker beyond its checked fixed-width
   unwind encodings and admit multiple executable loads without weakening the
   unresolved-reference gate;
3. emit total indirect page dispatch and bind every emitted body to its source
   proof;
4. run native differential parity and the fixed paired performance gate over
   the complete distribution root;
5. let `wasm-compiler` decode only this accepted optimized x86 ELF.

Unchanged source x86 currently remains only as an explicitly selected native
region; it is never interpreted and has no runtime descriptor. The release
gate requires the complete selected Linux/toolchain closure to use emitted
native bodies and retains no compatibility reader.
