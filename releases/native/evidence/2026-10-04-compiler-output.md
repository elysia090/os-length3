# Cold output witness with a minimal dirty frontier — 2026-10-04

## Fixed cost and derivation

The startup diagnostic previously wrote 0xa5 into the complete 65,536-byte
compiler output and 80-byte report before **every** cold emission. Almost
every emitted module is far smaller. These are repeated writes into an existing
private arena, not required guest work or a new allocation. Reducing their
traffic does not reduce the distribution's stored bytes or prove faster boot.

Let C be output capacity, R the fixed report and L the preceding successfully
declared module length. The C compiler owns the contract that success writes
only output[0..L) and R, while refusal writes neither. The witness starts with
poison in output[0..C) and R. Before a next emission, only output[0..L) and R
can contain a preceding successful result. Thus the sufficient exact reset is:

```text
initialization: poison output[0..C) and R
success(L):    dirty := L
next attempt:  poison output[0..dirty) and R if dirty != 0; dirty := 0
refusal:       compare ALL output[0..C) and R with poison
```

This keeps one bounded length, no prior output image, source history,
output-copy dictionary or extra compiler/guest memory. It never uses stale
output on refusal. Failed checks and host traps make the owner unusable.
Shared memory is rejected; this is a serialized diagnostic owner, not SMP
atomic publication. The private immutable C source and caller's disjoint
arena obligations are unchanged.

Illegal writes outside a successful declared L are not quietly normalized
away: they survive the prefix reset and fail the next full refusal comparison.
Full-capacity re-poisoning previously erased those bytes. The regression
explicitly makes this stronger check red under the full-reset model.

## Red, real C parity and fixed-work checkpoint

The initial full-reset implementation fails the bounded-write regression:
515 attempts clear 33,751,040 module bytes instead of the preceding prefixes'
127,437 bytes. After correction, fake success/refusal/sentinel models pass.
The unchanged C compiler then produces 513 full-capacity/report byte-identical
results against independent full-reset reference calls, and three identical
refusals (-105 tail, -102 grammar, -100 input). Supplying the actual second
source page after tail refusal also succeeds byte-identically. No ISA emission,
native expected result, compiler algorithm or output quota is changed.

The component's exact stores are:

```text
initial poison       65,616 bytes
module prefix clears 154,445 bytes
report clears         41,040 bytes
516 actual C attempts, including 3 full refusal comparisons
```

The independent bounded startup receipt
executes the same shipped kernel through C compiler -> C VM for 1,000,000
admissions / 1,616,430 retirements, ending at RIP 0x1e21a1a. Compared to the
preceding unchanged-C word-trace checkpoint, 32 architectural/source/trace/
resource observations agree, including complete independent initial-state
and relocation checks, REP/BSS/memset checks, next gate, full retained trace,
source and engine reuse, quota/residency and provider/compiler sizes.
RTC seed and timing are separate external inputs/measurements.

```text
cold emission attempts  1,773
old poison stores       116,337,168 bytes
new initial poison           65,616 bytes
new prefix clears           619,680 bytes
new report clears           141,760 bytes
new total                   827,056 bytes (99.289% less diagnostic store traffic)
```

Engine constructions remain 1,211, exact hits 562, retained witnesses
262,037 bytes, with 64 C source rows and 6,880 source metadata bytes. The
source/engine quotas, guest residency and emitted module bytes are unchanged.
The sample cold phase is 31.95 -> 33.22 ms, not a demonstrated latency
improvement; host noise and witness bookkeeping remain. Engine construction
is still the largest measured cost in the earlier long browser run.
These short independent Node checks do not replace the blocked browser
observation or establish Linux boot, a shell, x86 work/span minima or
three-second cold-shell acceptance.

Reproduce with `node data/oracle/check-compiler-output.mjs COMPILER.WASM` and
the normal bounded `check-wasm-startup.mjs` using the correct independently
observed hidden-segment fixture. Source-admission's 536 real emissions /
512 cold + 512 hot CPU comparisons, the bounded compiled-module owner and
100,000 trace-appends regressions remain green.

```text
VM 60,998 bytes
SHA256 dc6e01ad9e795ecb2a1615d1ad0b7f0c11edafb3eba0ff938b1a3beffefcbf51
compiler 437,635 bytes
SHA256 143d5b4cb0de386e6938212504082ea87dd45ac67f733d6716a2b9f2f059765f
```

No generated artifact was restaged, no retained Worker was restarted or
patched, and neither the native release bundle nor human UI was changed.
The strict independently reproduced CALL red remains open, with separate
[WHPX/TCG observations](2026-10-04-call-fault.md); none is retried into green.
