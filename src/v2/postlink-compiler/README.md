# postlink-compiler

The compiler and VM acceptance contract is in [CONTRACT.md](CONTRACT.md).  In
particular, a boot trace is test input rather than compiler input, and STEP is
an internal proof rather than the output instruction set.

The post-link compiler turns a linked x86-64 program image into directly
callable Wasm block functions bound to that image's executable pages.  It is
the producer; `vm.wasm` is the fixed target machine.  The VM does not decode
x86, interpret STEP, reconstruct records, or compile missing blocks.

```
source -> compiler -> linker -> linked x86 ELF
                                  |
                                  | postlink-compiler
                                  v
                    direct Wasm modules + page bindings
                                  |
                                  v
                               vm.wasm
```

It builds with `gcc` and nothing else, and it is meant to run **on x86** —
including inside the guest it compiles for, whose read-only `/usr` layer
carries the pinned GCC. A post-link compiler that needed a host Python or a
browser could not run there, which is why those routes are being removed
rather than kept as fallbacks.

## Build

```sh
make            # the native driver and the self-test
make library    # libpostlink.a; needs Makefile + include/ + src/ + pinned Zydis
make check      # run the self-test
make isa-completeness-check
make mmu-completeness-check
make linked-completeness-check X86_IMAGE=/path/to/vmlinux
make parity     # additionally prove the C codec against the Python writer
make guest      # a static binary for the guest's own toolchain
make wasm       # the library objects for the browser runtime
```

`make`, `make check` and `make parity` are verified with gcc 14.3.0, clean
under `-Wall -Wextra -Wpedantic -Wshadow -Wconversion -std=c11`.

`make guest` needs a static libc; it links against the guest's musl, and fails
on a host that ships only dynamic glibc. `make wasm` needs clang. Neither has
been run on the current development host, so both are declared rather than
tested.

The standalone distribution is `Makefile`, `include/`, `src/`, and the pinned
decoder-only `third_party/zydis` tree.  Only five Zydis translation units are
linked; its formatter and encoder are disabled, and no decoder code enters
`vm.wasm`.  `make library` in a copy containing only those paths produces
`build/libpostlink.a`; it does not inspect `check/`, import the Python oracle,
load JavaScript, or require an artifact.  Consumers may include the individual
headers or the aggregate `<postlink/postlink.h>`.

The three completeness targets are publication gates, not ordinary regression
tests.  They are expected to be red while work remains: the first fixes a
small boot-critical ISA/machine-operation witness set, the second compares a
direct MMU fault at the canonical exception cut, and the third requires every
valid coordinate in the selected linked image to have direct semantics.
`--require-semantics` and `--alias-require-semantics` make the ELF scanner exit
nonzero on an unsupported operation, anonymous machine barrier, grammar miss
or bounded-arena failure.  A valid decode alone is never green.

The first boot-frontier machine operation, `WRMSR`, is closed end to end: the
decoder names a typed `WRITE_MSR` action, the physical plan retains the exact
cut, emitted Wasm calls a dedicated VM import, and `vm.wasm` updates its
canonical MSR bank.  The integration fixture executes that block and checks
the EDX:EAX value.  A `WRMSR; ret` linked ELF publishes with zero barrier or
Wasm failures and passes `postlink-verify`; `LRETQ` remains the next red cut.

The library sources under `src/` are freestanding: no libc, no builtins, no
target assumptions beyond two's complement. Only the repository drivers under
`tools/` and `check/` use libc, so the browser runtime reuses the same objects
without a second source tree.

## Why this directory exists

The compiler was welded into three places at once, and no two of them could be
changed independently:

| where | what it holds | lines |
| --- | --- | --- |
| `kernel/x86.py` | `X86DBT` — decoder, block former, closure | 22,122 |
| `kernel/x86snapshot.py` | the artifact writer | 3,326 |
| `web/x86-machine.js` | a second, independent artifact *reader* | 970 |
| `vm/wasm/vm.c` | a third reader, plus the executor | 7,083 |
| `tools/*native_x86*` | 15 drivers importing each other | ~3,000 |

The record layout therefore existed three times, in three languages, with no
mechanical check that the three agreed. `include/postlink/format.h` is now the
one definition; `check/format_parity.py` fails the build if the Python writer
drifts from it. That check exists only while the Python writer still produces
artifacts and is deleted with it.

`vm.c` has the same problem internally: five unrelated subsystems share one
translation unit and one `union workspace` —

| lines | subsystem |
| --- | --- |
| 39–1130 | bit codec, sponge, `vm_load`/`vm_read`/`vm_feed` |
| 1132–1520 | `vm_guest_*`, a wasm bytecode interpreter |
| 1521–4230 | `vm_step_*`, `vm_program_*`, the STEP workspace |
| 5334–6960 | `vm_x86_*`, the x86 machine |
| 6963–7083 | `vm_eval_*` |

The x86 and STEP workspaces are deliberately coupled — they share one physical
byte array, so a STEP page and an MMU page are the same bytes. The other three
are only sharing an arena, and separate cleanly.

## What is here now

| path | what it is |
| --- | --- |
| `include/postlink/format.h` | the record layout: magics, header offsets, control codes, tag codes |
| `include/postlink/continuation.h` | the continuation residual codec |
| `include/postlink/machine.h` | the container framing and its region directory |
| `src/format.c` | record parse and validation |
| `src/continuation.c` | canonical continuation encode/decode and RIP projection |
| `src/machine.c` | container framing, with a targeted reader for the header's integer fields |
| `include/postlink/elf.h`, `src/elf.c` | bounded ELF64/x86-64 program-header reader: the first ordinary linked-program input boundary |
| `include/postlink/executable.h`, `src/executable.c` | direct block ABI plus canonical executable root for external Wasm modules, immutable memory objects and page-generation bindings |
| `include/postlink/entrymap.h`, `src/entrymap.c` | two-load page-offset to function-rank physical array, quotient-sharing equal 256-entry tail rows |
| `include/postlink/directory.h`, `src/directory.c` | migration-only STEP block admission by rank, resolving a RIP to coordinates without copying a byte |
| `include/postlink/dispatch.h`, `src/dispatch.c` | exact-hash residual partition refinement over normalized transfers and successor classes |
| `tools/inspect.c` | `postlink-inspect`, the first driver that reads a real artifact with no Python and no JavaScript in the path |
| `tools/elf.c` | `postlink-elf`, verifies and lists executable mappings from a normal ET_EXEC/ET_DYN input |
| `tools/admit.c` | `postlink-admit`, admits all 222,079 blocks and reports what record assembly costs |
| `check/selftest.c` | codec assertions and 13,932 continuation round-trips |
| `check/format_parity.py` | proves those round-trips against `kernel/x86snapshot.py` |
| `check/admit_parity.py` | proves 30,000 admissions field for field against the Python reader |

`postlink-inspect` on the shipped artifact:

```
  schema       x86-native-machine-v5
  payload      32811421 bytes
  header       2657 bytes at 26
  region page  65536 bytes
  memory       offset        65536  length      3342556  ( 10.2%)
  descriptors  offset      3473408  length      8791436  ( 26.8%)
  execution    offset     12320768  length     20490653  ( 62.4%)
```

## Measured baseline

A current real boot, `node tools/run_linux_worker.mjs
http://127.0.0.1:8000/artifact/ linux-x86-64-postlink`, reaches the BusyBox
prompt and runs one command in about five seconds.  Three warm-artifact runs of
the profiled VM had a 5,118 ms median; specializing projection tags once at
admission reduced that to 5,013 ms.

| quantity | boot value |
| --- | ---: |
| source x86 instructions retired | 35,128,920 |
| STEP work / nodes executed | 29,504,163 / 29,504,224 |
| block shape opens | 56,577 |
| cached block shape restores | 11,245,330 |
| STEP executor entries | 15,264,102 |
| projection graph queries after specialization | 64,436 |
| artifact mapped | roughly 100–140 ms |
| VM ready | roughly 365–420 ms |

The machine therefore retires only about 3.11 source instructions per loaded
block.  The 3,962,195 executor entries beyond block opens plus restores are
memory-page resumptions inside an already resident VM, not network fetches.
Artifact delivery is no longer the dominant term: block boundary restore,
STEP dispatch and memory resumption are.

Expanding the generic four-slot STEP memory window to 64 x86 tag slots proved
the distinction.  It removed 83.3% of the resumptions but regressed the boot
median from 4,966 ms to 5,421 ms because the broader metadata working set and
invalidation scans cost more than the removed entries.  That experiment was
rejected; the next memory form must use a small set-associative tag with lazy
generation invalidation rather than wider direct-mapped materialization.


## Normalization is a direct construction

`normalize_plan` alternates rewriting with compaction until nothing moves. That
alternation is an artifact of running the rewriter at the head of every pass, so
a rewriter that has not converged shows up as a compaction that needs another
sweep. Measured over 299 composed pairs, with the rewriter driven to its own
fixed point first so the two stages are not confounded:

| | |
| --- | --- |
| compaction enabled more rewriting | 0 of 299 |
| one compaction sweep suffices | 299 of 299 |
| `compact_once(rewrite_to_fixpoint(p))` equals `normalize_plan(p)` | 299 of 299 |

So the C side runs one compaction sweep and asserts a second would change
nothing, rather than looping.

The rewriter's own iteration is also removable, and by reordering rather than
rewriting. As written it runs `reopen_consumed_x86_alu` before
`rebase_overwritten_flags`, but the rebase is what creates the selector-16
projections the reopen looks for, so the reopen misses them and only finds them
on a later evaluation. Ordering the pre-passes

    reopen_pre_store_chains
    reopen_load_regions
    rebase_overwritten_flags        <- before
    reopen_consumed_x86_alu         <- after
    forward_memory_versions
    rewrite_relative_exchange

gives:

| evaluations to a fixed point | as written | reordered |
| --- | --- | --- |
| 1 | 221 | 271 |
| 2 | 65 | 28 |
| 3 | 13 | 0 |

reaching the identical fixed point on all 299 pairs. Two evaluations is the
floor for any fixed-point detection -- one productive sweep and one that
confirms -- so the reordered form is single-sweep.

`qm/stepnormalize.py` is deliberately left alone: it is the parity reference,
and changing the artifact producer is a separate decision. The ordering above is
the specification for the C rewriter.

## What is not here yet

Instruction framing is no longer in Python.  `x86.c` accepts linked ELF or
caller-owned raw executable maps, decodes every byte coordinate in C, preserves
the exact source cut and totalizes invalid, overlong and truncated fetches as
architectural faults.  `closure.c` expands every executable page to a total
function/fault projection.  Physical and virtual aliases are then interned by
`transfer.c` with collision-checked full equality; the complete decoded
instruction is transient rather than retained once per coordinate.

On the current Linux 7.1.8 `vmlinux`, `postlink-elf --alias-transfers` catalogs
19,186,970 physical-plus-virtual byte coordinates.  Exact alias/source transfer
sharing plus canonical terminal faults leaves 799,118 conservative classes;
18,387,852 coordinates share an existing rank.  The growable build workspace
settles at 1,048,576 identity rows and 2,097,152 hash slots, 25,165,824 bytes,
instead of reserving the 220,605,824-byte all-distinct upper bound.  The scan
finds 654 standard x86 mnemonic kinds, which is why semantics cannot be another
hand-maintained list of boot-observed opcodes.

What remains in Python is the semantic block former and its mature family
lowerings.  C must turn the normalized operands into SSA/QM, preserve every
fault and barrier ordering, and form successor closure.  A decoder hit is not
yet an executable function and is never reported as one.

The order the remaining stages move in:

1. **semantic lowering** — lower every decoded x86 family to normalized SSA,
   preserving precise faults, barriers, generations and both control arms.
2. **direct lowering** — lower normalized plans to
   `(i32 machine, i32 executable_context)->i64` Wasm block
   functions and total page-dispatch functions.
3. **compiler-side closure** — close all direct edges and indirect dispatch
   domains and reject publication if any coordinate lacks executable semantics.
4. **direct VM executor** — instantiate the emitted modules in a shared
   function table, then delete `vm_step_*`, X86B assembly, the JavaScript
   reader and every Python execution path.
5. **ordinary link integration** — run postlink-compiler after `ld` and publish
   the linked ELF plus its projection atomically.

## Artifact taxonomy

The names under `artifact/` did not say which artifacts were inputs, which
were outputs, and which were subsets of each other:

| name | format | what it is |
| --- | --- | --- |
| `linux-x86-64` | `x86-boot-cache-v1` | **input.** The 512 MiB physical RAM image: bzImage at its load addresses, initramfs, and the toolchain SquashFS mapped through `phram` at a reserved physical address |
| `linux-x86-64-postlink` | `x86-native-machine-v5` | **output.** What this compiler produces from that input |
| `toolchain` | `linux-x86-64-system-v1` | the musl/GCC system tar published on its own with a VFS index. Its bytes are already inside `linux-x86-64` as SquashFS; this is the pre-SquashFS canonical archive, kept for inspection and replacement |
| `compiler` | `webassembly-compiler-v1` | the browser's Clang, which emits **wasm**. Unrelated to the x86 path |
| `vm` | `webassembly-runtime-v1` | `vm.wasm`, built from `vm/wasm/vm.c` |

So `toolchain` is a subset of `linux-x86-64`, and `linux-x86-64-postlink` is a
function of it. The artifact formerly called `linux-x86-64-machine` is renamed
accordingly: "machine" named neither its input nor its producer, and read as
though it were a peer of `linux-x86-64` rather than derived from it.

`toolchain` currently has no runtime consumer — nothing under `web/` or
`kernel/` opens it by name. It is a 126 MB checked-in publication duplicating
bytes that `linux-x86-64` already carries.
