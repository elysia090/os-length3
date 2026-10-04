# Propagate a validated installed-body demand — 2026-10-05

Inspection found that C-source hits bypassed the engine lifetime owner.
The C owner correctly refreshed its bounded source row, but the engine's
Map order changed only on fresh cold output. A currently used instance could
therefore age behind inactive cold bodies. This is a lifetime-policy leak,
not evidence that guest ISA or the byte equivalence check can be bypassed.

The engine owner now accepts a demand hint only if both its key and opaque
instance identity match its retained entry. A stale, absent, changed-body or
other-owner handle cannot resurrect a discarded byte witness. It publishes
no function and grants no execution permission. C-MMU/source admission still
precedes every execution and every demand; new body construction still needs
exact cold-C output. Entry/module/byte quotas stay unchanged.

Red first: `check-compiled-modules.mjs` fails for missing `demand`. It now
passes two installed-hot/cold-stream cases, independently limited by entries
and bytes: 33 constructions, 32 validated demands, unchanged hot instance;
stale/foreign/missing handles and closed owners are checked. Original exact
body, changed body, LRU, byte quota, pending cancellation, link failure,
caller-arena reuse, independent-memory and grow checks remain green.

Sending a host Map update on every C source hit is **not** the adopted path.
The initial one-million-admission diagnostic sent 998,227 demands and took
2,866.1 ms vs a preceding 2,270.2 ms sample. These are noisy concurrent-host
samples, not a benchmark, but do not justify this added hot fixed cost.

Only cold admission can change retained engine membership. The supervisor
therefore transmits the first validated demand per C-selected slot after each
cold miss. A fixed 64-entry u32 array (256 bytes, under this diagnostic's
150-million-admission quota) records that cohort. No sort, unbounded history,
hash, extra code page or guest payload is materialized. Relative ordering
inside one cohort is not claimed to be exact LRU or an architectural fact.
The slot-to-instance map is bounded by the existing 64 C table slots and
replaces the former installed-slot set. Closing still clears every table slot
and engine owner. The same retained instance is never selected as a fallback
for a missing C source row.

The adopted default run sends 1,696 demands, retaining 1,616,430 retirements,
1,000,000 admissions, all CPU/source/trace/resident observations, zero copied
source bytes and the same 1,211 constructions / 460 evictions. Only explicit
UTC/clock sampling, cache policy metadata and times differ. Retained bytes
are 261,982 vs 262,037 under the same 262,144-byte limit. Diagnostic elapsed
is 2,199.8 ms. This short prefix does **not** demonstrate fewer Linux engine
constructions or cold-shell speedup; the larger working-set measurement
now has an independent same-bundle run. It reaches the same PUNPCKLDQ gate:
160,653,998 retirements / 86,601,736 admissions, 14,944,237 constructions,
14,943,493 evictions, 1,614,618 validated cohort demands and 262,139 retained
bytes. Complete decompression agrees and copied code bytes remain zero.
Engine construction is still dominant. Calibration/retired work differ from
the preceding run, so these counts/times do not establish a Linux speedup.
See [receipt and next common gate](2026-10-05-vector-unpack.md).

Latest completed logic startup predates this cohort change and stops at
PUNPCKLDQ after actually passing PXOR. See
[actual gate](2026-10-05-vector-logic.md). PID 1, shell, release-root mounting,
development tools, storage/recovery, network and real-browser acceptance
remain open. Native distribution and human UI are unchanged.
