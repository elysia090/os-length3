# Ordinary Linux input acceptance

The development environment must accept ordinary programs within its frozen
CPU and Linux contract, not just instructions seen in a boot trace or one
executable. The native post-link product preserves a wider host instruction
language; the browser projection uses the exact `development-standard-v2`
CPUID bitset in `x86/profile.h`. A valid advertised instruction that cannot
lower is a compiler defect. An absent feature has its architectural fault
meaning; it is not permission to fault an unimplemented advertised instruction.

## Correctness obligation

For an admitted code generation `g`, entry `p`, architectural state `s` and
explicit machine inputs `e`, let `X(g,p,s,e)` be the permitted x86 transition
and `C(g,p,s,e)` the compiled transition. Acceptance requires the same defined
observations: registers and flags, floating state, exact memory footprint,
ordered writes, exception vector/error/priority, committed prefix, next entry,
interrupt inhibition and continuation ownership. Undefined architectural
outputs use the documented compiler representative; reference comparisons
must not impose one physical processor's undefined choice on every machine.

Equivalence is conditional on the stated CPU/mode/device and serialization
contract, not on the values encountered while compiling. A resource wait is
neither a fault nor retirement. Supplying a page and resuming the retained
entry must neither replay a committed prefix nor lose a pending effect.
Different code generations, stale replies and invalid reservations cannot
reuse an accepted entry. Guest memory faults remain distinct from unavailable
host pages and unsupported execution contexts.

A local law plus preservation of its boundary invariants supports composition
by induction over committed cuts. That argument needs exact fault/event and
code-generation closure too. A finite test suite, successful decode, valid
Wasm, source-coordinate count or boot announcement alone does not discharge
the quantified obligation.

Transcendental and reciprocal approximations obey the architecture's error
and special-value contracts, not an undocumented polynomial from one CPU.
The product emits stateless common SSA operations into ordinary Wasm; host
numeric libraries remain independent test references. Tests keep exact
accesses, aliases, defined faults and publication boundaries separate from
numeric error enclosures. C1 and the result tag must describe the emitted
implementation's own final rounding and value. At an analytically established
normal/subnormal boundary, an approximate physical CPU can choose a different
underflow transition; the compiler representative and its pending-error/FOP
equation are checked independently, not masked without a boundary proof.
For FYL2XP1 the documented out-of-range result is undefined. Its explicit
floating-invalid representative is tested on those inputs without deleting
them or replacing the valid instruction with an illegal-opcode fault.

## Required input domains

| Domain | Required population and observations |
| --- | --- |
| CPU and instruction forms | Every advertised family; legal widths, GPR/high-byte/MMX/XMM coordinates, register aliases, encoding variants, immediate/count edges and feature-absence faults. |
| Addresses and memory | 32/64-bit addressing, base/index/scale/disp, RIP-relative and segment roles; canonical edges, exact extents, all page splits, paging rights, A/D writes, aliasing, source mutation and precise access/fault order. |
| Architectural state | Carry/live flags, floating precision/rounding/masks, NaNs/denormals/signed zero, CPL/control/descriptor context, inhibition, pending faults, supported mode transitions and explicit debug/alignment obligations. |
| Whole programs | Ordinary static/dynamic ET_EXEC and ET_DYN, functions/files/libraries/archive members, relocation and alternatives; every final PF_X byte including interior/padding/zero-fill, both direct arms, indirect targets and authenticated executable generations. |
| Generated programs | The release GCC/as/ld output, static and dynamic links, arbitrary accepted C functions and executables, libraries and executable mapping changes. A frozen release inventory is not the future generated-code domain. |
| Linux operations | Automatic offline PID1/shell; compile/link/run, parallel builds, Git/packages/archive/crypto; x86, signal, futex, clone3, exec, timers, ptrace, pipe/IPC, mm, tty, seccomp and net behavior. |
| External resources | Authenticated page supply, dirty publish/close/reopen, cancellation/revocation, corrupt/stale/duplicate replies, Worker restart, grants and network failure/recovery. Linux remains syscall/VFS/process/socket authority. |

All seven domains are required for product acceptance. Context refusals such
as an unimplemented debug/alignment transition, unavailable test prerequisites,
skipped tests and exhausted diagnostic quotas are not successful ordinary
inputs. Keep them visible without disguising them as architectural faults.

## Independent instruction population

`distribution/oracle/x86-profile-inputs.mjs` declares the input language independently
of the product decoder. `prepare-profile-inputs.mjs` uses GNU as, objcopy and
nm to obtain exact one-instruction byte intervals. It creates a fresh directory
and retains assembly, object, text bytes and records. `profile-input-fixture.mjs`
regenerates the entire declared population and verifies exact assembly and
instruction-byte hashes before the product is consulted. Deleting a difficult
row, changing its fault expectation or truncating the population is a refusal.
An object section's trailing alignment padding is hashed separately from the
actual instruction population.

```text
node distribution/oracle/prepare-profile-inputs.mjs AS OBJCOPY NM temp/NEW-DIRECTORY
node distribution/oracle/check-profile-fixture.mjs
node distribution/oracle/check-profile-inputs.mjs COMPILER.WASM temp/NEW-DIRECTORY/inputs.json
node distribution/oracle/check-byte-alu-inputs.mjs COMPILER.WASM temp/NEW-DIRECTORY/inputs.json
```

The full default population covers all 16×16 register pairs where declared
legal, all MMX pairs, every base coordinate, index/scale coordinates, 32/64-bit
addressing and signed displacement edges. Immediate families include all
256 controls on an explicit alias form. Address, immediate, destination and
payload dimensions are **not** a full Cartesian product. The optional
`--boundary` population is explicitly smaller, never substituted for the full
gate. Neither population is the complete 15-byte x86 encoding language.

The admission report keeps every declared row, validates the emitted ordinary
Wasm and its exact source extent, and counts unchanged grammar refusals,
false fault substitution, invalid modules and other failures separately.
Ordinary instructions and deliberate architectural-fault witnesses have
separate denominators. GNU as establishes encoding, not execution semantics.

`check-byte-alu-inputs.mjs` exhausts all 256×256 operand pairs and both incoming
CF values for nine AL/CL binary operations. It compares actual emitted Wasm
with independently stated arithmetic/flag equations and poisoned full-state
preservation, including RF clearing. Breakpoints and TF are disabled; logical
AF uses the documented zero representative. This is complete for that finite
operand domain, not for arbitrary 64-bit values, MMU/debug contexts or Linux.

Physical CPU observations, native post-linked ELF parity, exact C VM/MMU
comparisons and ASan/UBSan remain separate gates. Their receipts retain source,
compiler, input and release identities so that results from different builds
cannot be combined into a fictitious release-wide pass.

## Release and Linux gates

Run the existing complete final-ELF inventory on the entire immutable release
population, including toolchain helpers, libraries, service executables and
the real kernel's executable generations. One make inventory does not certify
the distribution. Inventory must precede publication; the runtime has no
missing-instruction interpreter or guessed fault substitution.

Use the pinned official kernel's kselftest installation/runner for the declared
Linux domains, with that candidate kernel's configuration and explicit
prerequisites. Build/install with `FORCE_TARGETS=1` so one successful target
cannot hide failures in the rest. Preserve KTAP pass/fail/skip results; a missing tool, unsupported
configuration or skipped required family stays an acceptance gap. Tests and
oracle binaries belong in distribution/temp, not the minimal release payload. Native
reference tests and actual browser tests retain distinct receipts.

Normal automatic boot must use the ordinary immutable root and unchanged
deadlines, profile and clock policy. A failure-only rescue shell or manually
repeated warm service transition can diagnose a defect but cannot certify
interactive-ready. C compile/run, make -j, Git and package checks must run
through the same guest Linux boundary and current C VM, not a host substitute.

Instruction definitions come from the [Intel architecture manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
the emitted SIMD spelling from the [WebAssembly SIMD encoding](https://github.com/WebAssembly/simd/blob/main/proposals/simd/BinarySIMD.md),
and Linux suite selection/installation from [kselftest documentation](https://docs.kernel.org/dev-tools/kselftest.html).
