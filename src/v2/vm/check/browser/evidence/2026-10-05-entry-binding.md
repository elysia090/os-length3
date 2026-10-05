# Admitted coordinates and shared execution templates — 2026-10-05

The [coordinate-sharing red](2026-10-05-coordinate-sharing.md) is now green.
This is a typed execution representation change, not Linux/browser acceptance
or a global work/span optimum. Native release bytes and human UI are unchanged.

## Representation and authority

For decoder-owned coordinate `a` and admitted entry `b`, substitution is
`a = b + (a - b) mod 2^64`. The emitted function receives `b` by value from
the exact C-admitted row. Its type is now machine-entry ABI 2:

```
cut(i32 state_offset, i32 port_offset, i64 admitted_entry) -> i64 result
```

Only decoder RIP, fallthrough, RIP/EIP-relative base, direct relative targets,
CALL/software-interrupt return coordinates and #DE instruction coordinates use
this substitution. Address32 truncation stays at its original operation.
Immediate literals, loaded branch targets and guest pointers are not rebound.
No parameter image or per-coordinate global instance is reconstructed.

The exact RIP test remains. Source generation, permissions, CPU/MMU context,
cross-page fetch and fault order are still validated per coordinate by C.
REP/residency/host waits retain the original row, including its entry and slot;
changing the caller's row cannot substitute another binding during resumption.
VM and compiler export ABI 2. An old two-argument table function traps before
its first store; there is no compatibility interpreter/entry adapter.

The bounded Worker engine owner accepts only exact immutable emitted bytes,
not a coordinate key. A numeric fingerprint locates candidates but the entire
byte witness decides identity. Two deliberately colliding valid modules
(fingerprint 867302654) return different values and remain distinct. Duplicate
pending requests recheck exact bytes before publication. Failed compilation,
linking, cancellation, foreign imports, eviction and SharedArrayBuffer input
cannot publish or resurrect a witness. Eviction deletes the instance's weak
association as well as its byte bucket; installed table slots do not keep the
owner's witness alive indirectly. Quotas remain 1,024 entries / 262,144 bytes.

## Evidence, with separate scopes

* [Coordinate covariance/template receipt](2026-10-05-coordinate-sharing-green.json):
  ten operation shapes, twelve coordinates each, 960 complete normalized-state
  comparisons, 120 unchanged wrong-RIP refusals and memory growth. Each family
  has one exact body instead of twelve. At 4,096 requests to the same bounded
  owner, constructions become 10 instead of 4,096; witnesses occupy 2,431 bytes
  instead of the red's 252,056 bytes. This is a fixture stream, not the kernel's
  entire topology population or measured Linux speedup.
* [Actual C-MMU/typed binding receipt](2026-10-05-entry-binding.json): eight shared
  templates at five coordinates (including the high half), 40 full-state/RAM
  comparisons, 40 wrong-binding refusals, five precise #DE coordinates,
  40 source-fetch faults, ten latched REP resumes including descriptor mutation
  and memory growth, and one old-signature trap with no CPU mutation. It checks
  literal preservation, RIP/EIP load/LEA, CALL return and absolute RET target.
  These explicit frontier models do not replace native ISA observations.
* Fresh independent native/cold emissions and actual C-MMU checks pass for
  register DIV/IDIV (16,384 observations / 10,348 #DE), memory DIV/IDIV (36,864 /
  19,598 #DE and 36,864 read #PF), indirect CALL (6,912 CPU/stack observations),
  indirect branches (6,144), eight software-interrupt forms (1,024 frame models),
  vector transfers (49,152), scalar transfers (6,912), MXCSR (4,096) and fences
  (7,680). Undefined flags and the distinction between pending fault and entered
  exception frame remain explicit. Native fixtures run in the independent WHPX
  build VM, not physical hardware or a product fallback.
* Fresh REP MOVS/STOS each pass 336 native CPU/RAM receipts, 144 bounded latch
  resumes, source-code alias continuation, fault/miss frontiers and descriptor
  entry mutation. The old test's RF refusal was stale: the existing common
  emitter already accepts RF, preserves it on incomplete returns and clears it
  on successful retirement. No guest lowering was changed to repair this test.
  Forty-eight additional RF frontier models now check that contract explicitly;
  native POPF-based rows are not claimed to establish RF behavior.
* Full C VM and compiler/CLI checks pass without compiler warnings. Scoped
  ASan/UBSan checks pass for execution directory/latch, register/memory division,
  software interrupt, vector transfer and memory-order lowering. These are
  scoped checks, not exhaustive sanitizer coverage of the distribution.

The [matched one-million-admission prefix](2026-10-05-node-startup-binding-matched.json)
uses the old prefix's identical segment/input setup, without the optional root
image. Forty-two non-size/non-owner/non-clock/non-timing top-level observations
agree, including complete recorded trace, final CPU, 1,616,430 retirements and
unchanged source-cache observations. Constructions fall 1,211 -> 905; evictions
460 -> 143 under unchanged quotas. This establishes reduced construction work,
not a total runtime speedup: elapsed time is approximately unchanged.
The separate [root-image prefix](2026-10-05-node-startup-binding-prefix.json)
passes, but its different command input is not used for that parity claim.

Final compiler: 446,940 bytes, SHA-256
`ca7788b12f97b52cf3c44d13923d7edc66217c7c6a69141f5ad357496c7bd245`.
Final VM: 63,085 bytes, SHA-256
`f4a7155ec5dfe4d2fb7decc4f5a06d38a49f752841e951bfe93eaf7f8cc1e928`.
The previous compiler was 446,566 bytes and VM 63,052 bytes; this change removes
per-coordinate engine population, not the size of either compiler executable.

## Previous completed full-bundle measurement

The [fence startup receipt](2026-10-05-node-startup-fence-quota.json) completed
before ABI 2. It actually passes LFENCE and initializes PF_INET/TCP/UDP and
PF_UNIX/PF_LOCAL. It stops at the unchanged 150,000,000-admission diagnostic
limit, at 247,565,228 retirements / RIP `0xffffffff81086f0e`, not an unsupported
opcode. Complete kernel decompression remains exact. Raw receipt SHA-256:
`6760cabca1db054e2192c66adf090ffce8883362b7bc88e2ac8bde4bbf2fbb0a`.

The largest measured old term is 73,441,447 engine constructions / 1,985,421 ms.
Cold C emission is 674,917 ms, execution 358,598 ms, admission 52,148 ms and
extent supply 195 ms; total check approximately 3,421,203 ms. Source-cache hits
are 71,277,185, misses 78,722,815, capacity 64 and metadata 6,880 bytes with
zero copied source payload. Allocated linear Memory is 21,037,056 bytes, not
process RSS. Source reconstruction remains a candidate after template sharing;
raising quotas is not the demonstrated normalization.

The unchanged published bundle, independent segments, root image and full
diagnostic limits must be rerun with ABI 2 before claiming a Linux improvement.
PID 1, root mount/shell/development commands, storage/recovery, granted network,
real browser acceptance and cold shell within three seconds remain open.

## Reproduction

```
node data/oracle/check-cut-coordinate-sharing.mjs COMPILER.WASM
node data/oracle/check-compiled-modules.mjs
node data/oracle/check-entry-binding.mjs VM.WASM COMPILER.WASM
node data/oracle/check-divide.mjs VM.WASM COMPILER.WASM FRESH-DIVIDE-DIR
node data/oracle/check-memory-divide.mjs VM.WASM COMPILER.WASM FRESH-MEMORY-DIVIDE-DIR
node data/oracle/check-software-interrupt.mjs VM.WASM COMPILER.WASM FRESH-INT-DIR
node data/oracle/check-repeat.mjs VM.WASM FRESH-REP-DIR movs
node data/oracle/check-repeat.mjs VM.WASM FRESH-REP-DIR stos
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIR --extended --progress --segments=INDEPENDENT-SEGMENTS --image=UNCHANGED-ROOT-IMAGE
```

Fresh native fixtures use the current C compiler. Old emitted ABI-1 binaries
are immutable historical evidence, never repaired into an execution fallback.
No retained browser Worker or staged browser binary was replaced by this work.
