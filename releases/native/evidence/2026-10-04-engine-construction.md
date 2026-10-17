# Bounded engine construction and word-only observations

## Measured dominance, not a guessed boot percentage

The retained MXCSR browser Worker is still running. At 147,060,462 retired
source instructions / 76,741,824 admissions it has 5,717 console bytes and
RIP 0xffffffff810a8207. This is early Linux initialization, not PID 1,
a release-root mount, shell, usable networking, or acceptance of LDMXCSR.
The exact [running observation](2026-10-04-engine-linux-running.json) records:

| Phase | Cumulative milliseconds |
| --- | ---: |
| Host engine construction/reuse | 791,865.9 |
| Cold C compiler | 140,363.6 |
| C execution | 118,533.4 |
| C admission | 67,130.7 |
| Authenticated page supply | 285.1 |

There are 5,928,170 engine constructions, 2,163,116 exact-byte reuse hits,
5,927,423 quota evictions, and 746 retained entries / 262,028 witness bytes.
Request-time reasons are 5,928,169 absent keys and one changed body. An
absent key can be genuinely new or already evicted; no unbounded history is
retained, so these counters alone do not establish a unique working set or
prove that every absent request is recompilation. The 256 KiB witness quota
does not bound the engine's native-code RSS.

This Worker was loaded before this host change. It is not restarted or
patched in place. Its clock, CPU, guest source, and C authorities remain intact.

## Fixed cost removed without a second execution path

The caller is a serialized execution Worker. A newly emitted body is already
resident, at most 65,536 bytes, and must be constructed before that caller
can execute it. The old owner schedules `WebAssembly.compile` and then
asynchronous instantiation for each absent/changed tiny body. The new owner
uses `new WebAssembly.Module` / `new WebAssembly.Instance` at the same
publication boundary. Large initial provider/compiler loaders remain
asynchronous; there is no optional legacy construction or guest interpreter
in the bounded owner. Module quota remains 64 KiB; witness/entry quotas are
unchanged. The owner belongs in the execution Worker, not the UI thread.

The [standard Module constructor](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Module/Module)
is synchronous; large/UI-thread use is explicitly discouraged. The
[V8 compilation pipeline](https://v8.dev/docs/wasm-compilation-pipeline)
documents both construction APIs as ways to measure baseline compilation.
These references justify the API boundary, not a claimed Linux speedup.

Owned bytes are copied before a microtask cancellation point. A close before
that point performs zero Module constructions. Failed compile/link and close
during construction cannot publish a witness or remove a valid entry.
Exact emitted bytes still gate every hit; imported memory belongs to this
owner, caller-arena reuse cannot poison it, and table placement is not identity.
LRU and both quotas remain enforced. The new no-scheduled-compile test fails
on the preceding owner with `unexpected scheduled tiny compilation`, then
passes after the change. Invalid emission, changed body, pending close,
duplicate pending requests, frozen import bindings, memory growth, arena reuse
before cancellation, link failure and both hot/cold eviction streams pass.

## Actual browser comparison

The separate comparison Worker asks the unchanged C cold compiler to emit
768 unique one-instruction MOV cuts, all 238 bytes. Each of three construction
methods executes each cut against a whole 1,256-byte CPU preservation model:
2,304 comparisons per run. Six rounds rotate which API encounters fresh
bytes first. Other positions can benefit from engine-internal byte caching.
All positions and rounds are retained in the receipts, not only the winner.

| Browser measurement | Before | After |
| --- | ---: | ---: |
| Bounded-owner construction, all 768 bodies (ms) | 71.2 | 32.6 |
| Owner when first to encounter bytes, 256 bodies (ms) | 36.0 | 18.8 |
| Independent asynchronous reference, all bodies (ms) | 66.0 | 79.3 |
| Independent inline reference, all bodies (ms) | 25.5 | 29.7 |

The owner decrease is approximately 54.2% overall and 47.8% fresh-first in
these observations. Background Linux work and engine caches affect timing;
this is neither a deterministic timing gate nor a full Linux cold-boot speedup.
See [before](2026-10-04-engine-construction-before.json) and
[after](2026-10-04-engine-construction-after.json).

The actual MXCSR native-fault comparison now obtains its executable through
this owner: 16 exact native/cold emissions, 4,096 stable pre-lowering records,
4,096 direct / 4,096 C-dispatch / 8,192 RF CPU/RAM comparisons, 6,720 native
fault comparisons, 224 control-priority models, 56 waits/retries, 224 entry
refusals and 32 unrelated-state preservation models remain green. AC/TF,
FS/GS and incomplete SIMD/exception closure are not relaxed. The known
intermittent native CALL oracle red remains open, not retried into a claim
of resolution.

## No per-cut formatted trace materialization

The startup diagnostic previously formatted seven hex strings and a result
string into an object on every cut, retaining only its last 16 objects.
There is no need to retain that presentation before a publication. Its new
trace is a fixed 16-row numeric ring: eight u64 words plus one u16 count per
row, 1,056 payload bytes. It reads the same guest fields and never writes
guest state. JSON objects/strings are formed only for an explicit read.
The output schema and oldest-to-newest order stay identical, including the
last-four error trace and bounded relocation observations.

An independent eager-object reference checks 100,000 ring appends, 133
full/suffix/empty comparisons, zero hot-path hex conversions, fixed payload,
invalid observation limits and unchanged guest bytes. The unchanged default
startup quota still retires 1,616,430 instructions at 1,000,000 admissions:
19 architectural/source/resource/final-trace fields exactly match the saved
preceding default receipt, including full relocation observations. Timings,
RTC snapshot and clock-event counts are measured values, not byte-equality
or speedup claims. `timingMs.elapsedCheck` now also includes unpartitioned
supervisor/observation work and setup inside `checkStartup`; it does not
include downloads before that call and is not cold-shell latency.

## Reproduce and continue the full goal

```sh
node data/oracle/check-compiled-modules.mjs
node data/oracle/check-cut-trace.mjs
node data/oracle/check-engine-construction.mjs temp/mxcsr-1004/compiler.wasm
node data/oracle/check-mxcsr.mjs temp/source-lifetime-1004/vm.wasm \
  temp/mxcsr-1004/compiler.wasm temp/mxcsr-1004/mxcsr-native-1004 \
  temp/mxcsr-1004/mxcsr-native-before-1004
node data/oracle/check-wasm-startup.mjs temp/source-lifetime-1004/vm.wasm \
  temp/mxcsr-1004/compiler.wasm src/v2/vm/check/browser/generated-startup
```

The comparison page is `src/v2/vm/check/browser/engine-construction.html`.
The retained old startup tab stays running. A second independently bounded
startup Worker loads the verified owner/word trace and exactly the same
kernel/segments/compiler/provider fixtures. Its first saved
[running observation](2026-10-04-inline-startup-running.json) is at
135,060,457 retirements / 67,974,085 admissions, RIP 0xffffffff81414d13,
3,839 resident pages / 16,252,928 C-memory bytes and no console bytes.
The new `elapsedCheck` field confirms the updated diagnostic was loaded.
Concurrent runs are not an isolated cold-boot latency benchmark. Neither diagnostic pass replaces the
goal: actual Linux/PID 1, offline C compile/run, make -j4, Git/apk, minimal
authenticated storage/recovery and granted virtual-NIC HTTPS/service reachability.
No native bundle or human-facing UI is changed; the three-second shell goal
remains unmet. Further unique working-set/coordinate/topology work, ISA/MMU
gates, and the native CALL oracle red remain open.
