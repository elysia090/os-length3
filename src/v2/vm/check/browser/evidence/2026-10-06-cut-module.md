# One typed module interface for compiled cuts — 2026-10-06

## Why whole-image emission could not reuse the cut backend

Each old cut chose one of 19 handwritten type/import/export byte layouts.
Its body assumed callback index 0 (or 1/2) meant that cut's own provider.
Mixing e.g. access, segment, control, I/O and descriptor transfer in one module
would therefore call the wrong provider or fail Wasm type validation.

The replacement has one construction-time definition of 22 callback names and
signatures. Every body reports the callbacks it actually emits. A module
assigns indices to those identities, and signature-equal callbacks share one
type while retaining distinct functions. Both isolated and collected cuts
use this same emitter. The old header branches and numeric call assumptions
are deleted, not retained as a fallback. No ISA callback or serialized
execution stream was introduced; the output is standard Wasm.

An initial manual control/far-return identity swap was caught RED by frozen
standalone-byte parity and corrected before this checkpoint. The test was not
weakened. The memory-segment import case uses existing supported LLDT memory;
MOV FS from memory remains a real grammar gap, not claimed supported here.

## Bounded collection, not fake closure

The independent C compiler now emits up to 256 explicitly admitted cuts into
one <=64 KiB module. Entries are distinct/increasing, imports/types are shared,
and functions export cut.0, cut.1, ... (one cut retains the existing name cut).
Each still has machine-entry ABI 3 and its own exact source span/count/binding,
fault and retirement boundary. One transient plan plus bounded body lengths
is recycled; no instruction-object population or private program is retained.

All cuts and aliases/capacity are preflighted before publication writes. The
caller borrows immutable inputs. Wrong order, unlowered later cut, cap/input/
output alias and unsupported population leave outputs unchanged. The C-Wasm
wrapper checks complete disjoint reservations, not merely short actual output.
The new selected-cut APIs are available for both accepted optimized ELF and
the existing explicitly diagnostic raw-page entrance. They are not a whole
program CLI escape hatch and do NOT establish total ELF/function/control/
indirect/executable-generation closure. Whole-image publication still refuses.

## Verification and measured scope

[Mixed-module receipt](2026-10-06-mixed-module-green.json):

* 28 mixed cuts exercise all 22 typed callback identities;
* all 28 standalone outputs match the frozen previous compiler byte-for-byte;
* native C and cold C emit exactly the same collected module;
* 112 full-memory/callback-argument routing comparisons (test spies only);
* 54 separately scoped actual C-VM/source/MMU/table/permission/fault/CPU/shadow/
  halt comparisons against frozen standalone emission;
* native preflight controls cover seven unchanged failures and 129-function
  ULEB count/index boundaries; the actual engine validates that module.

The collection is 12,786 bytes instead of 14,367 bytes for its 28 standalone
modules: 1,581 bytes (11.0%) of repeated headers/declarations removed.
This is fixture module storage, NOT Linux release delivery, fetched bytes,
runtime work/span or a measured Linux speedup.

[Vector receipt](2026-10-06-module-vector-green.json) preserves 464 native/cold
byte-identical emissions, 59,392 direct + 59,392 C-dispatch native observations,
118,784 RF comparisons and 78,272 native fault-frame comparisons, plus existing
boundary/control cases. [Events](2026-10-06-module-interrupt-green.json) retain
224 independent x86 system comparisons including 32 HLT cases. The earlier
source-cohort check also passes. Full native compiler/CLI and postlink checks
pass; none is a real-browser observation or complete Linux acceptance.

The separately rebuilt native cold-emitter library and collection test pass
ASan/UBSan (build-module-san, -O1, no recovery). That run instruments emitter,
interface, sizing/alias and collection code; its x86/optimized-ELF/support
provider archives remain the normal native builds. Do not expand this to a
Wasm-engine or fully instrumented decoder/provider claim.

```text
compiler.wasm 453,310 bytes
5538c12efef55f556c3717327ec816748a59ea5a89a64f5d48c00606ed3ce6a3
mixed 28-cut module 12,786 bytes
f4f637df6b1dc7eef38de4f07bf9f32b4ee0238c82cacd525976ec384b5f27fd
```

The compiler is 3,619 bytes smaller than the HLT-only build despite adding the
collection entrance. VM, native release, UI, retained browser assets/Workers
and cache quotas are unchanged by this candidate. No service timeout, clock
or guest wait was relaxed. The latest same-bundle Linux result still halts
correctly after s6 Broken pipe/timeout; there is no working terminal.

## Next obligation

Derive the complete coordinate/edge population from the accepted final ELF
and its load/patch/CPU context, including precise faults and every legal
indirect target; emit bounded modules using this common interface; bind their
authenticated Artifact projection and source/span/binding obligations into the
C loader/table owner. A finite observed trace or selected list cannot replace
that obligation. Do not use a runtime decoder, interpreter or guessed fault
for an unclosed coordinate. Normalized scalar SSA migration, s6 readiness,
idle events, old web retirement, authenticated storage/recovery, granted
networking and actual-browser offline development/three-second shell remain
unachieved. The full goal stays active.
