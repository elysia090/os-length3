# Compiler boundary checkpoint — 2026-10-02

Build through `make -C src/v2 wasm-compiler` so the ordinary ELF reader,
support library, public cold x86 decoder and machine ABI providers finish before
the product links. `make -C src/v2/wasm-compiler check` checks rejection and real
cut emission. Node execution comparison and whole-image coverage are separate
gates. The public CLI is included in `all`.

## Rejected reopen invalidates an accepted image

Before the fix, opening invalid ELF bytes returned a proof error while the
compiler retained the previous borrowed image and counts. The poisoned-state
regression failed on all four clearing assertions. `wasm_compiler_open` now
constructs a temporary candidate and clears the complete compiler on failure.

The same regression also passes with a genuinely admitted image from the
published bundle, followed by malformed and NULL input. C ASan/UBSan and leak
detection pass on that test. The input is:

```
release:       os-length3-linux-v0.1.0-rc.1
publication:   1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195
path:          root/bin/busybox
ELF SHA256:    62a1aa4720607ec8c3ec38c50041cc7ff3dae9e29ebd335b589283c8e0381212
```

After authenticated bundle extraction, reproduce with:

```
make -C src/v2 wasm-compiler
make -C src/v2/wasm-compiler accepted-input-check INPUT=/absolute/path/root/bin/busybox
```

The observed result is:

```
Accepted ELF -> rejected reopen: green
Wasm compiler admission: green (not executable projection)
```

## Executable projection is still red

Run the separate product gate against the same input:

```
make -C src/v2/wasm-compiler projection-check INPUT=/absolute/path/root/bin/busybox
```

The proof-bearing optimized ELF opens, then emission returns `-104`:

```
wasm-compiler: whole-image executable lowering is incomplete; no module was published
wasm-compiler: refused input (-104)
executable Wasm projection: red (compiler did not emit)
```

Do not mark this red gate green with a valid module header, the small browser
fixture, or source proof counts. Those counts are not decoded optimized-x86
block boundaries or a Wasm coverage proof. Complete executable lowering and
machine-ABI differential execution must be connected first. Neither the
native bundle nor the human UI was changed by these boundary checks.

## Actual bounded register cuts — 2026-10-02

`wasm-compiler/cut.h` compiles a requested optimized-ELF coordinate until a
limit, a direct control cut, or before an unlowered transfer. It does not claim
the continuation or whole ELF is covered. All source meaning comes from
ordinary PF_X segments; no proof count is mistaken for a block table. The new
`x86` dependency is cold compiler machinery only. The generated module imports
one ordinary wasm32 `machine.memory` and exports `cut(i32) -> i64`; it imports
no source reader, host function or decoder. Architectural addresses stay i64.

Supported transfers in this checkpoint are register/immediate MOV, MOVZX/SX,
LEA, ADD/SUB, AND/OR/XOR, CMP/TEST, INC/DEC, NEG/NOT, NOP and direct Jcc/JMP.
Narrow/high-byte writes preserve their parent, 32-bit writes zero its upper
half, INC/DEC preserve carry and arithmetic flags are computed at operand
width. Logical AF is undefined and is not compared with an invented native
value. Memory, precise faults, calls/returns, system/SIMD/x87 transfers and
dynamic executable-generation admission remain unimplemented in this backend.
Long-mode, zero-load-bias input and an event-free admitted cut are prerequisites.
The generated state guard rejects wrong RIP, TF/RF, misalignment and a missing
complete state reservation before any write; it is not a Linux fault handler.
The supervisor still must bind executable generation, verified instruction-fetch
permissions and the admitted event/debug context. A state-pointer guard alone
is not code admission, an MMU or proof of precise instruction-fetch exceptions.

Only needed parent registers are loaded; only changed registers/flags are
written at the cut. XMM/system/x87 state is not copied. `retired` counts accepted
source instructions; work/span are left unchanged rather than filled with
unproved costs. There is no decoded-instruction array or ELF-sized heap: up to
64 borrowed segment maps and one decoded instruction are transient stack
objects. The 1024-source-instruction and module-byte limits fail explicitly.
Emission rejects output overlap with borrowed input or control descriptors.

Flags use a per-bit last-definition frontier. No supported nonterminal transfer
consumes arithmetic flags; INC/DEC retain CF and a terminal Jcc consumes the
final definitions. Therefore only those last definitions need computation.
This condition must be extended before admitting ADC/CMOV or an interior flag
consumer. The same composed optimized ELF (SHA256
`97b248e6b4cbb48760de8c218c6f976313fd04dd221e128bdbe9d6a593aa0140`)
emits **454 -> 366 Wasm bytes**, with unchanged observations. The former module
fails the new <=400-byte regression gate; the reduced one passes. ADD -> INC
retains only the earlier carry definition instead of deleting it. A separate
<=360-byte witness prevents reintroducing all intermediate ADD flags there.
These are executable-byte budgets, not a timing speedup or global minimum proof.
Planning, body-size measurement and emission are bounded linear passes over
the borrowed maps; no dry-run module re-decodes and reconstructs a second body.

The first admitted fixture emitted no executable body (`-104`): red. A later
alias witness reproduced ELF mutation on a failed output operation: two
assertions red, then green after disjoint-output admission. Reproduce:

```sh
make -C src/v2 all
make -C src/v2/wasm-compiler check
bash data/oracle/check-wasm-cuts.sh temp/new-wasm-cut-records
node data/oracle/check-wasm-cuts.mjs temp/new-wasm-cut-records
```

Each of the 76 fixtures is genuinely linked, post-link compiled and independently
verified before lowering. The native oracle executes those optimized bytes
with register/flag inputs, replacing the excluded final barrier with RET only
in its private test mapping. Branch observers run beyond the compared cut only
to identify the taken arm. RSP reads observe the harness's actual stack; RSP
writes are not admitted to that oracle. This instrumentation is never a VM
execution route or a distribution input. Oracle records include 16 boundary
value families and seeded inputs. Node checks complete linear memory, defined
flags, continuation, retirement, memory growth and nonmutating rejection.

The published BusyBox SHA256 above also passes a three-instruction entry prefix
(`XOR RBP,RBP; MOV RDI,RSP; LEA RSI,[RIP+disp]`) -> 298-byte Wasm module.
Its following stack alignment write and CALL are not certified by this oracle.
The actual result is **77 modules / 39,424 comparisons green**. The engine is
Node 24.21.0; x86 observations use the existing Alpine GCC 15.2 build guest.
This is not an actual-browser test, Linux boot, a speed benchmark or coverage
of all BusyBox/kernel instructions. Full `projection-check` remains red.
C ASan/UBSan and the root product `check` also pass; the latter's benchmark
fixture is not a new native distribution timing measurement. Published native
bundle bytes and the human UI remain unchanged.

Instruction/flag references are the
[Intel manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
and the [WebAssembly binary instruction specification](https://webassembly.github.io/spec/core/binary/instructions.html).
