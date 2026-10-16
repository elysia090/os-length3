# Exact scalar regions and retained-source writes — 2026-10-09

The same published make's entire PF_X byte inventory improves **368 ->329**:
233,126 lowerable of233,455.4 floating comparison aliases and35 MOVSS/MOVSD
coordinates are recovered. First remaining is0f06/CLTS at0xb4b9. Remaining
x87150/SIMD86/far91/other2 retain the unchanged total publication gate.
Native release, signed delivery and human UI are unchanged.

## One scalar-region law, no FP calculation or unrelated old-region read

MOVSS/MOVSD register/memory copies and the existing register MOVQ clearing
case now share an independent x86 law consumed by the existing scalar transfer
emitter. No new VM operation, source interpreter, lane array or numeric helper
is added. SSE #UD/#NM guards precede every form, including register aliases;
pending x87 errors and unmasked numeric MXCSR bits do not make a move numeric.

The normalized effects are directly physical:

- register MOVSS/MOVSD: copy only4/8 bytes; preserve the remaining XMM region;
- memory load: read only4/8 bytes, then publish the scalar plus known zero
  remainder with one v128 store;
- memory store: write only4/8 bytes through the same C scalar preflight;
- alias preserving copy: no payload read/write, but retain the guard/retirement;
- register MOVQ: keep the low64 source and clear the high64, including aliases.

The preserving32-bit form uses a32-bit store, not an8-byte overwrite or
read/blend/rebuild of the old vector. Clearing builds only the final result;
it does not materialize an intermediate vector record. Raw NaNs, denormals,
signed zeros and arbitrary bits are copies; MXCSR and x87 payload/tag/TOP stay
unchanged. The old ad hoc kind39 acceptance is removed and malformed shared
laws fail before semantic/byte publication. This follows the
[Intel MOVSS/MOVSD region contract](https://cdrdv2-public.intel.com/774492/325383-sdm-vol-2abcd.pdf).

4,352 source/address/register/direction forms and69,632 malformed controls
pass.240 independent local Windows source encodings/15,360 complete physical
FP/MXCSR/tag/RFLAGS/memory rows match cold C -> ordinary Wasm -> C-MMU/table.
GPR invariance is architectural, not a bare-metal all-register certificate.
Existing MOVQ/selected-half populations still pass:9,984 native CPU/RAM
observations, including1,148 independent fault frames.

## Decoded floating comparison aliases join the existing relation/publisher

The common status-comparison frontend now normalizes DC D0..DF and DE D0..D7
to the existing ordered compare/no-pop or single-pop relation. No backend
numeric or state rule is duplicated.536 total prefix/family forms and6,432
malformed/no-clobber gates pass (192/2,304 are the new alias portion).

24 encodings x4 IM/DM profiles x256 raw extended/empty/source/TOP states give
24,576 independent physical comparisons through24 modules. All defined state
matches the existing C comparison publisher, including deferred unmasked
exceptions and suppressed pops. These extra encodings are observed behavior
of the tested Intel projection and the existing decoder, not a claim that the
SDM documents or every FPU clone supports them. The standard comparison
contract remains the [Intel status-word rule](https://cdrdv2-public.intel.com/874240/325462-090-sdm-vol-1-2abcd-3abcd-4.pdf).

## Remove a resumed-data-write admission fixed cost, retain revocation

The general write observer already invalidates exact retained executable
extents before RAM mutation. Previously, a resumed source-owned instruction
was nevertheless fenced on **every** write. A completed ordinary data store
returned STALE5, forcing re-admission despite an unchanged source.

The source-owned resumed path now derives its rank in O(1) from the existing
slot and compares all five frozen row fields to the still-owned row. Only
matching generation/ownership, a retained valid bit and an unchanged complete
source-valid set permit reuse. Flat directories, foreign rows and actual
source mutation retain their revocation fence. No scan, copied source bytes,
new history, replayed operand, extra quota or runtime dispatch stream is added.
The next cut still rewalks guest MMU/physical identity after data/page-table
changes. This is a pinned serialized execution rule, not an SMP/lease claim.

The new boundary test first made resumed data store **STALE5 vs1** red while
confirming completed/retired1. The final test passes2,049 comparisons:
1,840 faults,32 ordinary waits,16 unchanged-state retries and176 immediate
successes; its extra resumed **real code write** still yields STALE5 after
retiring once. No permission/source validation is dropped to obtain reuse.

Existing independent ENTER CPU/partial-RAM records pass8,064 comparisons /
3,984 faults /252 exact resumptions. The UART input-read-once, output-byte
latching and two bounded REP resumptions remain green. Their earlier expected
coarse data-write revocation is updated to the exact source-owned outcome;
all prior CPU/RAM/fault/latch checks remain. Source-cohort tests pass42
comparisons,2 code-write revocations,10 disjoint-write runs and3 revalidated
writes. The selector A/D/source-latch matrix also remains green1,442 cases.

Full VM checks, scoped compiler/postlink and positive ASan/UBSan are
warning-free, with464 postlink semantic witnesses. The unrestricted intermittent
native CALL RAM-payload red remains separately retained. The same-bundle
bounded prefix still has86-cut/1,617,931-retirement witnesses; this is not PID1,
browser shell/cold3s/RSS, recovery or a complete signed Linux publication.

Compiler747,377 bytes, SHA256
`f3a9e44b48dd7ea3f0a6052ebca3238491b901a20f0337e157760621319384b1`.
ABI4 VM99,110 bytes, SHA256
`4bbd6a814be8c8514e107286f9de660816c2c029bfacd12b8269da2f2f7ff571`.
These local module sizes are not whole-release compression or speed claims.

```sh
make -C src/v2/x86 all
make -C src/v2/wasm-compiler all scalar-vector-transfer-check x87-status-check vector-scalar-check
SCALAR-VECTOR-OBSERVER NEW-MOVE-DIRECTORY
STATUS-OBSERVER NEW-ALIAS-DIRECTORY --aliases
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-MOVE-DIRECTORY --scalar-vector-transfer
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-ALIAS-DIRECTORY --status-aliases
node data/oracle/check-scalar-vector-boundary.mjs VM.WASM COMPILER.WASM
node data/oracle/check-source-cohort.mjs VM.WASM COMPILER.WASM
bash src/v2/wasm-compiler/check/sanitizers.sh
```

The live TODO is rewritten from current acceptance and missing families;
completed historical work stays in evidence instead of stale pending entries.
Continue common CLTS, floating/SIMD and far-control closure to ZERO and the
actual-browser development objective.
