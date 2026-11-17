# File-core resource ledger

This is an operation ledger, not an elapsed-time benchmark or a browser result.
Run with the selected real core:

```
SODS_CORE_WASM=/path/to/sods_core.wasm node --test module/sods/test/runtime/core-cost.test.ts
```

## Conditions and identical work

Each row starts from a fresh 4,096-byte raw pack mounted through the real pack reader,
with the same expected payload under TS and Rust storage. It uses real File/mapping
operations but not a guest syscall, scheduler, filesystem network service or compressed
pack. The wrapper counts host-to-core export calls, including failures, without changing
arguments/results. Successful `files_input` bytes are **prepared input length**, not
independently measured copies. Successful completed read length is recorded separately.
Initial instance setup, mount and scenario preparation are outside the measured phase;
verification and accounting are after its snapshot. Warm/reload are prepared explicitly.
No clock comparison is made because wrappers and assertions would distort one.

Mapping cases use two equal-extent standalone arrays as simulated process backing,
not actual Process/mmap syscalls. They have one shared baseline and changes in
the first mapping only. Both storage paths must produce identical canonical/guest
bytes. The same 2,048 changed bytes are contiguous in one case and alternate with
unchanged bytes in another, isolating dirty-run count from payload size.

## Observed selected debug Wasm, Node 24, 4 KiB payload

| Operation | Core export calls | Prepared input | Completed read | Pack range bytes | Hash input bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| First readInto | 13 | 4096 | 4096 | 4128 | 4128 |
| Warm readInto | 9 | 0 | 4096 | 0 | 0 |
| Release, unmapped | 3 | 0 | 0 | 0 | 0 |
| Reload/readInto | 13 | 4096 | 4096 | 4096 | 4096 |
| One-byte write | 10 | 1 | 0 | 0 | 0 |
| Clean mapping settle | 1 | 0 | 0 | 0 | 0 |
| One dirty byte | 12 | 1 | 0 | 0 | 0 |
| 2048 dirty contiguous bytes | 12 | 2048 | 0 | 0 | 0 |
| 2048 alternating dirty bytes | 22529 | 2048 | 0 | 0 | 0 |

TS has no core export calls, but is not free: it performs pack verification, data
movement and the same mapping comparison/publication. Pack and hash quantities match
between both paths. Initial table verification costs the extra 32 bytes in this
single-file pack; reload retains the verified table but checks content again.

Canonical resident logical bytes are 4,096 except after release (zero). Mapped cases
retain 8,192 simulated-mapping backing bytes plus one 4,096-byte baseline, not two
distinct baselines. Baseline bytes count unique ArrayBuffer backing lengths; do not
sum these columns into a process-memory total.
Scratch logical length remains 4,096 after release and read cases, becomes 1 after the
one-byte/alternating writes, and 2,048 after contiguous writes. Length is not capacity.
The selected debug core exposes 1,179,648 bytes of linear memory for these cases even
after release. This is not file residency or process RSS: allocator, stack, heap and
retained pages are included and Wasm memory does not shrink on Vec release.

## Source-derived work, not instrumented counters

- Cold/reload must obtain and authenticate the selected content under this pack trust
  contract. The selected representation also captures host bytes, fills core scratch,
  optionally transfers or copies into canonical storage, and copies read scratch into
  the destination. Decode is zero only because this fixture is explicitly raw.
- A warm owned-destination read must populate the destination. The current Rust path
  additionally copies canonical bytes to leased scratch. Its nine crossings include
  repeated materialization/size/source checks; these are representation costs, not a
  semantic lower bound. Removing checks must retain loader/reentry/lifetime behavior.
- With arbitrary guest-writable memory and no trusted dirty metadata, proving a clean
  mapping requires inspecting its relevant bytes. Current settle scans each mapping's
  pages; changed pages also scan runs after the initial equality check. Shared baseline
  storage does not eliminate per-mapping comparison.
- For r dirty runs, the observed Rust settle path uses 1 + 11r export calls here.
  Repeated own/materialize/source checks scale with runs although accepted byte count
  is unchanged. Each run is captured, marshalled and written; `show` then writes both
  guest arrays and their baseline slots, including two writes to the same shared
  baseline. These costs are not justified merely by changing implementation language.

## Prioritized remaining work

The strongest bounded finding is call amplification by fragmented mapping writes,
not evidence that every workload is dominated by it. Compare a page/span-batched
publication against the current per-run route before choosing an ABI. The resulting
decision is recorded in the final section below. It must preserve
which dirty bytes win, publication to other mappings, source retirement, ordering,
partial failure, metadata version/change counts, and memory/attempt lifetime. Extra
staging or descriptor scans must be counted. Changing the mutable memory model would
be a larger alternative and must account for translation/access costs elsewhere.

Do not immediately replace this with a whole-page write: unchanged bytes may contain
newer canonical/other-mapping state. Do not introduce a TS shadow of Rust source
ownership to suppress calls. This ledger justifies that next design comparison; it
does not itself justify an untested batching implementation.

Current-source translator availability, real browser cache and everyday desktop
compatibility are unrelated open gates and remain unverified by this measurement.

## Publication batching decision after counterexamples

`mapping-publication-contract.test.ts` records three constraints: sparse writes must
not erase another mapping's independent dirty bytes; the first run's canonical and
visible update survives a later run failure; and a publication through a shifted
alias can change a later source observation. These are File/Mapping embedding tests,
not a claim that an unaligned mapping is valid native Linux. Existing syscall tests
remain the separate check of implemented mmap/remap behavior.

Source audit adds a real runtime concern: `forkProcess(vm=true)` shares memory but
copies mapping records only in the non-VM `live` branch. A child MAP_FIXED removes
only its own mapping records. Parent and child can therefore retain records on one
backing with different translations. Current mmap/munmap paths do not provide a
universal alignment invariant that would eliminate intra-page aliases. This is a
source-derived path, not a newly executed end-to-end clone regression or a claim
that the current model is fully Linux-compatible.

A page-gather candidate would need at least non-shared backing, byteOffset-aware
alias exclusion, one mapping/page per batch, and unchanged cross-page/map order.
Unknown backing or SharedArrayBuffer must fall back until synchronization is proven.
Even those guards do not preserve failure prefixes: canonical batch application
followed by several `show` calls can leave more canonical effects ahead of visible
publication than the current run-at-a-time contract. Returning an applied-run count
alone does not solve failure during `show`. Preparing all runs also changes which
prefix exists if later capture/allocation fails.

Decision: do not adopt page-wide batching yet. The smaller next candidate retains
`capture → own → write → show` per run and removes redundant materialize/source
queries at the private core boundary for already-resident mapped payloads. Rust must
still validate readiness/handle/input lease, and callback cleanup must retain exactly
one owner without a mutable TS shadow of core state. This can reduce constants, not
remove the O(r) crossings. Page batching remains a distinct contract change requiring
proof of non-failing post-admission publication or explicit revised failure semantics.
Neither route permits unconditional whole-page replacement.
