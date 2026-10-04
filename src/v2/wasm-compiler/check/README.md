# Compiler boundary checkpoint — 2026-10-02

Current IF boundary (2026-10-04): common CLI/STI emits one precise
`machine.interrupt_flag` call. C owns privilege, IF and inhibition; generated
code owns successful RIP/RF/retirement. The old inline CLI implementation is
removed. 768 generated cases, 169 native/cold emission comparisons and selected
compiler sanitizers pass. [Independent system and browser evidence](../../vm/check/browser/evidence/2026-10-04-interrupt.md)
records the saved-RF oracle discrepancy and incomplete CPL/IST/debug scope.
The later dated checkpoints below retain their historical observations.

Current register-summary coverage (2026-10-03): `summary-fixture-check` emits
75 ordinary linked -> optimized -> proof-verified fixtures. Native execution
and direct/C-dispatch Wasm comparisons are separately reproduced with
`data/oracle/prepare-summary-cuts.sh`. The decoder's immutable-profile view
closes legacy F3 BSF/BSR without changing native superset semantics. Prefixed
native twins and undefined zero destinations are explicitly marked in receipts;
they are not hardware F3 observations or Linux/PID 1 acceptance. See
[the oracle scope](../../../../data/oracle/README.md).

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
one ordinary wasm32 `machine.memory` and exports `cut(i32 state, i32 port) -> i64`; it imports
no source reader, host function or decoder. Architectural addresses stay i64.

Supported transfers in this checkpoint are register/immediate MOV, MOVZX/SX,
LEA, ADD/SUB, AND/OR/XOR, CMP/TEST, INC/DEC, NEG/NOT, NOP and direct Jcc/JMP.
Narrow/high-byte writes preserve their parent, 32-bit writes zero its upper
half, INC/DEC preserve carry and arithmetic flags are computed at operand
width. Logical AF is undefined and is not compared with an invented native
value. The RAM boundary checkpoint below adds scalar memory cuts; actual MMU
fault delivery, calls/returns, system/SIMD/x87 transfers and dynamic
executable-generation admission remain unimplemented in this backend.
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

The initial register checkpoint used a per-bit last-definition frontier. No supported nonterminal transfer
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

## Scalar RAM cuts — 2026-10-02

MOV loads/stores, including narrow/high-byte parents, MOVZX/SX, signed
immediate stores, address32 truncation, indexed and RIP-relative addressing,
now emit one-instruction memory cuts. A preceding pure cut ends **before** the
faulting instruction; the memory cut updates registers/RIP/retired only after
its complete RAM transaction succeeds. The module imports `machine.memory`
and the typed C boundary `machine.access`, and exports `cut(i32 state, i32 port)`.
No instruction bytes, decoded operation descriptor or per-byte host calls are
in that boundary. `machine/memory.h` fixes its address/range/right/value ABI.
State/port extents, alignment and disjointness are checked before calling it.
AC, TF/RF and FS/GS accesses remain explicit rejection rather than guessed
alignment, segment or debug semantics.

`vm/core/memory.c` admits **already translated** resident page projections.
The supervisor owns their CPU/MMU context, generation and synchronous lifetime.
It excludes the state/port arena from guest RAM, keeps 64-bit guest addresses,
and preflights at most two page fragments before a scalar store. Physical
aliases and noncontiguous resident pages are allowed. It copies neither the
whole machine state nor pages, allocates no heap, and uses only two fragment
coordinates. A missing/denied/deferred translation returns a bounded admission
request containing the original address, width and right. It is not falsely
reported as a guest page fault or zero-filled RAM. Only an explicit cached
exception for that access/context produces a pending fault. The supervisor,
not this RAM cache, must deliver it and set CR2 where appropriate. This is a
serialized owner boundary, **not a complete x86 MMU, device layer or SMP atomicity
proof**. Future concurrent eviction needs a pinned/fenced owner protocol.

The previous register-only library rejects the same post-linked memory fixture
with `-102`. Current emission passes **22 modules / 11,264 native-x86 versus
Node-Wasm comparisons**, plus failure-return noncommit, invalid/aliased port,
debug/alignment rejection, memory growth and prefix-commit checks. The first
test run exposed a test-oracle error: after `MOV RDI,[RDI]`, failure retry reused
the loaded RDI instead of restoring the pre-instruction address. Restoring the
complete input before each retry makes the alias case meaningful and green.
The C resident boundary passes 100,000 scalar write/read round trips, separate
cross-page partial-store, cached-fault direction, high/kernel address, physical
alias, stale-generation, invalid-reopen and reserved-arena checks.

ASan/UBSan, including leak detection, also pass. The new native oracle first
failed because its fixed 64-bit test mapping intersected ASan's reserved shadow
gap; the rejected mmap path leaked its ELF input buffer. The oracle now uses
application high memory and one cleanup path for files, mappings and input,
without disabling sanitizer checks or overwriting an existing mapping.

```sh
make -C src/v2 all
make -C src/v2/wasm-compiler check
make -C src/v2/wasm-compiler build/memory-cut-check
bash data/oracle/check-wasm-memory.sh temp/new-memory-cut-records
node data/oracle/check-wasm-memory.mjs temp/new-memory-cut-records
make -C src/v2/vm check
```

The original Node access callback remains a **test double**, not a product JS
execution route. The subsequent actual C-Wasm integration below supersedes
that checkpoint; do not relabel the original callback results as C-provider
execution. Do not add fixture counts to kernel coverage or claim browser boot,
distribution speed/size improvement or a native re-bake.
Published native bundle bytes and the human UI are unchanged.

## Actual C-Wasm MMU and stack/control cuts

The scope-local build in `data/oracle/wasm-tools.ps1` now links the C resident
physical directory and four-level 4 KiB/2 MiB MMU into `vm.wasm` with exactly
one import: `machine.memory`. Generated cuts import its actual `vm_access`
function. All 22 memory modules plus 11 64-bit PUSH/POP/direct CALL/RET modules
pass 16,896 native-x86/Node comparisons through this provider, with no JS guest
memory semantics. Its ordinary-Worker actual browser observation is 512 cases;
see `vm/check/browser/evidence/README.md` for that exact 3,920-byte build.
The current loader-enabled provider is a later build, not that receipt.

Stack fixtures use a separate instrumented native jump/catch trampoline so
PUSH RSP, POP RSP, RET immediate and CALL's true source return coordinate are
observed without a hidden oracle stack write. Only the test mapping's catcher
and relocation bias are normalized. Full register/RAM results and failure
noncommit remain checked. ASan/UBSan and leak checks also pass.

CLC/STC/CLD/STD now participate in the per-bit final flag frontier. Six new
fixtures include overwritten direction/carry definitions and arithmetic
interleaving; the native trampoline clears host DF only after capturing guest
flags, as required by the C calling convention. The 82 pure fixtures plus
the actual shipped BusyBox prefix pass 83 modules / 42,496 comparisons.
At that checkpoint CMC, STI, indirect/far/CET control and full system/SIMD/x87
lowering were unsupported; newer common coverage is recorded separately.
Shared fixture tools finish once before parallel test execution;
concurrent recursive relinking previously reproduced an execution failure.

The actual shipped bzImage also passes C-native/C-Wasm initial page/state
comparison and MMU fetch at `0x1000200`, using bounded object-source extents.
That initial-page gate does not execute startup or certify a Linux boot. The boot
loader follows the [Linux 64-bit protocol](https://www.kernel.org/doc/html/latest/arch/x86/boot.html);
complete executable admission, hidden segment
state, CPU exception delivery and interrupt/device/root supply remain red.

## Uniform C dispatch and raw executable-page admission

All cuts now have `machine/entry.h`'s two-parameter table type, including pure
cuts (which ignore the port). The old pure function type reproduced a real
C `call_indirect` signature mismatch. The common type passes 83 modules /
42,496 native cases through `vm/core/execution.c`, as well as direct calls.
The directory borrows source-span/table-slot rows and performs C-MMU fetch
checks before invocation. Prefixes end before crossing/page-start instructions;
a crossing first instruction is emitted alone. A fetch-time revoke first
failed the native directory test, then passed with the pre-call fence.
RAM payload AND page-table A/D writes invalidate the code snapshot, including
when a later fault occurs; physical code/table aliasing is not assumed absent.
This conservative baseline has no disjoint-write-set optimization claim.

`wasm_compiler_*_code_cut` borrows one/two resident executable pages with a
nonzero generation. It uses the identical planner and emitter as accepted ELF
cuts and rejects implicit zero-fill, stale/mixed generation and output aliasing.
Its shape checks are NOT source authentication, ELF-proof admission or complete
CPU/MMU/executable-generation attestation. The cold supervisor owes those gates.

The earlier shipped startup checkpoint produced three direct cuts (`CLD`, CLI,
`XOR eax,eax`). It has now advanced to fourteen instructions across eleven cuts
through typed C segment loads, with ENTRY_MAP at memory ADD `0x1000232`;
split budgets preserve the same state. Versioned hidden caches preserve the
frozen register ABI, and MOV SS requires the next cut to contain one instruction.
Generated segment cuts pass 8,272 model cases through C-Wasm, not a hardware
fault/debug-entry oracle. See vm/check/browser/evidence/2026-10-02-segments.md.
CLI clears IF for CPL <= IOPL, otherwise publishes #GP(0) without retirement.
PVI/VM contexts reject without mutation. The 16 privilege combinations are an
independent specification matrix, not a native CPL0/QEMU fault-entry proof.
See the [Intel manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html).
At that checkpoint STI, memory-source segment loads, control-register/mode
transfers, complete interrupt/debug delivery and Linux boot were red. No source instruction
is interpreted or silently skipped.

The current shared C-Wasm path additionally admits memory-destination
ADD/SUB/AND/OR/XOR, ten-byte LGDT/LIDT records and same-CPL 64-bit far RET.
The 22 new RMW modules pass 11,264 native-x86 comparisons. The shipped bzImage
now executes 86 startup instructions in an actual browser Worker and compares
all CPU/cache bytes; it stops at SETA `0x12e299e`, not Linux boot.
Outer-CPL/compatibility far transfers and full exception delivery remain red.
See vm/check/browser/evidence/2026-10-02-rmw-control.md for reservation/Accessed
write regressions, exact builds and reproducible cold construction.
The later 2026-10-02-control-read.md checkpoint adds common CR0/CR2/CR3/CR4/CR8
reads: 80 modules, 5,360 privilege/value model cases and 247 total native/cold
byte-identical emissions including repeats. This is not a hardware CPL0 fault oracle.

The later 2026-10-02-control-write.md checkpoint adds common CR0/2/3/4/8 writes
through the C semantic boundary: 486 native model cases and 80 generated
modules / 23,360 C-Wasm model cases. Reserved bits, CR0/CR3 normalization,
privilege, equal-value invalidation and reservation cancellation are explicit.
Sixteen memory CMP/TEST modules pass 8,192 actual native-x86/C-Wasm comparisons,
including operand order, narrow/high-byte operands and split-page failure
noncommit. All 362 native/cold emissions are byte-identical. No Linux boot or
hardware exception-entry claim follows from these gates.

```sh
mkdir temp/new-control
src/v2/wasm-compiler/build/code-cut-check temp/new-control
node data/oracle/check-control-read.mjs temp/new-control
node data/oracle/check-control-write.mjs VM.WASM temp/new-control
bash data/oracle/prepare-compare-cuts.sh temp/new-compare
node data/oracle/check-wasm-provider.mjs VM.WASM temp/new-compare
```

## Conditional shift frontier — 2026-10-02

Common register SHL/SHR/SAR lower directly to integer Wasm, not a VM opcode
callback. Immediate/CL, 8/16/32/64-bit parents, high bytes and aliases are tested.
Only unconditional flag definitions kill earlier ones. For each bit, retain
the final unconditional definition and all following conditional definitions;
count zero leaves those incoming flags intact. This is two bounded linear passes
with twelve ranks, no per-instruction flag/state materialization. Interior flag
consumers remain refused until their separate use/definition dependencies exist.

The native observer now emits one flags mask per input. Undefined multi-bit
OF/AF and narrow logical-shift CF are excluded only where undefined, not from
count-zero observations. It refuses dynamic-count fixtures whose earlier
instructions changed RCX; it does not implement a guest interpreter. All 128
CL count representatives and seeded inputs are observed on actual native x86.

The preimplementation shift fixture refused with -102. **156 post-linked
modules / 79,872 cases** now pass both direct Wasm and actual C table/MMU
dispatch. Existing pure/memory/RMW/stack/CMP tests remain green; **534** total
native/cold emissions are byte-identical including repeats. Full C checks and
compiler ASan/UBSan pass. The same shipped bzImage reaches **86** instructions
in an ordinary-memory browser Worker; SETA AL still refuses emission with -102
and leaves the output reservation unchanged. No Linux/PID 1/cold-ready claim.
See [the current receipt](../../vm/check/browser/evidence/2026-10-02-shifts.md).

```sh
bash data/oracle/prepare-shift-cuts.sh temp/new-shifts
node data/oracle/check-wasm-cuts.mjs temp/new-shifts
node data/oracle/check-wasm-dispatch.mjs VM.WASM temp/new-shifts
```

```sh
node data/oracle/check-wasm-dispatch.mjs VM.WASM PURE-NATIVE-RECORDS
node data/oracle/check-wasm-boot.mjs VM.WASM SHIPPED-BOOT-PREFIX COMPILED-CODE-PREFIX
node data/oracle/check-provider-worker.mjs
```

The last command exercises only the diagnostic Worker's setup under Node with
fixture delivery adapted to files. Its guest execution is actual C-Wasm, but
it is NOT a browser permission/Worker/transport observation or Linux boot.

## Fixed CPU and stack flags — 2026-10-03

CPUID emits the fixed release profile as constants, not host CPUID or a VM
operation import. All four zero-extended outputs and unchanged CPU words are
checked against an independent literal table: 7,504 direct/C-dispatch cases,
plus 15,008 unchanged TF/RF refusals. Non-structured leaves ignore ECX;
structured rows currently all vanish to zero. A profile change must update
the normative table and its independent red gate, never discover host bits.

Both 16/64-bit PUSHF/POPF use the existing precise C MMU stack transfer. The
POPF mask comes from CPL and incoming IOPL; reserved/VM/VIF/VIP bits persist,
RF clears, and AC/ID are full-width only. Four emission refusals were first
RED. 8,192 CPL/IOPL CPU/RAM cases, 4,096 real CPL3 record comparisons, and 36
stack-fault/pending/stale/alias/entry-flag cases now pass. The assembly observer
restores host flags and never enables TF/AC/NT on the host. Model coverage of
those bits is not an exception/debug/interrupt delivery proof.

```sh
mkdir temp/new-flags
build/code-cut-check temp/new-flags
build/flags-check temp/new-flags/native.bin
node ../../../data/oracle/check-cpuid.mjs VM.WASM temp/new-flags
node ../../../data/oracle/check-stack-flags.mjs VM.WASM temp/new-flags
```

The actual browser startup reaches 378 instructions and checks the derived
relocation registers, then refuses REP MOVSQ at `0x1000281`. Complete CPU/cache
observation at 86 is preserved. Linux boot and whole-image closure remain RED.
See [the build-specific receipt](../../vm/check/browser/evidence/2026-10-03-cpu-stack-flags.md).
