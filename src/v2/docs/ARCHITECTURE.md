# Architecture

The responsibility contracts are [POST-COMPILE.md](POST-COMPILE.md),
[ARTIFACT.md](ARTIFACT.md), [STORAGE.md](STORAGE.md),
[PACKAGE.md](PACKAGE.md), [NETWORK.md](NETWORK.md) and
[DISTRIBUTION.md](DISTRIBUTION.md). Browser acceptance and its exact current
evidence are in [BROWSER.md](BROWSER.md). None of these contracts is fulfilled
merely by an instruction fixture or a partial startup.

## One program, two execution projections

```text
ordinary compiler/linker
    -> linked x86-64 ELF
    -> postlink-compiler
    -> independently runnable optimized x86-64 ELF + proof
         |-> native x86 execution
         `-> cold wasm-compiler -> bounded Wasm modules -> C vm.wasm
```

Only the ordinary optimized ELF is the canonical executable. A transient SSA,
a decoder row or a derived Wasm module is not another release format.
Wasm coverage is over the instructions in the relinked accepted output,
including its exact fault/control behavior under the release CPU contract.
The browser backend must not re-optimize the original linked input.

## Source ownership

| Product/library | Sole responsibility |
| --- | --- |
| support | Checked arithmetic, caller-owned arenas, hashes and finite-future primitives |
| x86 | ELF/source maps, architectural decode, exact instruction laws and transient typed SSA |
| optimized-x86 | Independently check the optimized ordinary ELF and its proof |
| postlink-compiler | Whole-ELF closure/selection/layout/relocation and ordinary x86 output |
| machine-abi | CPU state, precise accesses, events, continuation and result contracts |
| wasm-compiler | Lower accepted x86 semantics to bounded ordinary Wasm |
| artifact | Authenticated identities, roots, indexes and resources |
| storage | Untrusted delivery, encryption, erasure, leases and recovery |
| vm | C RAM/MMU, CPU control/fault/event/device state and compiled-function dispatch |
| web | Opaque transport, Wasm-engine admission, Worker lifetime and presentation |

Both compilers link the same x86 library. Its `sources.mk` is the sole source
population for native and cold-Wasm builds. The Windows SDK helper invokes
the product Makefiles; it has no private source/export/linker list.
The VM links neither the decoder nor either compiler.

## Shared construction, not shared interpretation

The x86 library owns `pl_x86_lower`, `pl_compose_raw`, algebraic normalization,
backward DCE, pure-node sharing and dependency-wave construction. These are
freestanding operations over caller-owned transient arenas. Native formation
calls them before selection; their former postlink-private source copies and
headers no longer exist. Build-side plan serialization remains private to
postlink construction and cannot become a VM instruction stream.

Static vector permutations are a coordinate substitution over one or two
128-bit inputs. Equal input coordinates merge before lowering; an identity
publication is deleted. A backend emits the selection without re-deriving
PSHUFD/SHUFPS/PSHUFHW/PSHUFLW/MOVSHDUP/MOVSLDUP semantics. A memory input retains
one complete precise preflight and its architectural fault order even when
the value permutation is identity.

Packed integer add, equality and bitwise logic similarly consume one shared
lane-parametric binary law. Equal input coordinates become identity/zero/ones
before emission; AND-NOT source order belongs to the x86 frontend. The Wasm
backend emits standard SIMD rather than rebuilding word-carry networks or
scalar lane loops. Its former arithmetic lower is deleted. This does not
claim that register/ALU/flags lowering already consumes the shared block DAG.

Whole-byte shifts use that same coordinate projection with a translated old
region and zero-default. Identity/constant eliminate the old payload input.
Source ownership separately quotients request caps only when a fixed transfer
fits the current cap; the latest demand policy is not compiled-body identity.
Exact source/write/physical-owner checks and executable MMU admission remain.

This migration is not complete: the scalar cold emitter still walks admitted
instructions and owns independent ALU/flags/address spelling. Moving the common
SSA sources is not evidence that this emitter uses block-wide normalization.
Its next obligation is to consume the shared normalized transfer, delete the
replaced instruction-wise rules, and pass native/Wasm/fault parity.

## Current machine and publication boundary

The modern machine is built from `vm/wasm/entry.c` and `vm/core`. The
historical `vm/wasm/vm.c` and its unowned benchmarks are deleted.
Generated functions import C MMU/machine boundaries;
JavaScript does not execute guest instructions. Source-generation publication
and module construction happen outside an in-flight compiled cut.

The diagnostic raw-page entrance borrows at most two immutable executable
pages after C source admission. It uses the same cold emitter as proved ELF
cuts, but does not independently authenticate the release or prove complete
executable closure. A generated or patched executable generation must obtain
the same admission/proof obligations before publication.

Whole-image function/dispatch emission still reports incomplete. The current
same-bundle startup checks are not a published browser execution product.
Linux owns syscall, VFS, process, signal and network semantics; there is no
browser POSIX or Linux-function fallback.

Historical `web/vm.js`, its old Worker/storage callers and the old runtime
catalog remain separate retirement work. They are not inputs to the modern
startup checker and must not be enabled as a fallback. Retiring them requires
reconnecting their consumers to the modern C boundaries, not silently dropping
storage validation or substituting an interpreter.

## Verification

Each moved source has one owner and one archive member. Native postlink and
cold-Wasm checks include independently executed source x86, precise fault
frames, source/context refusal and full-state comparisons. Model counts,
native reference-VM observations, Node-engine execution and actual browser
observations are reported separately.

Publication requires the full [BROWSER.md](BROWSER.md) acceptance: real Linux
PID 1/offline shell, C/make/Git/package use, authenticated bounded delivery,
workspace recovery, granted networking and browser service reachability.
Cold shell three seconds remains a measured target, not a fixture result.
