# Source budget quotient and byte-region projection — 2026-10-06

## Completed actual gate

The [completed 3147e94 run](2026-10-06-node-startup-psrldq-red.json)
passes PCMPEQD and retires 242,172,992 instructions / 133,002,483 admissions.
The next compiler -102 is `66 0f 73 d9 08` (PSRLDQ xmm1,8),
RIP `0x7f7289383862`. Frozen compiler/VM 456,366 / 70,499 bytes,
warmCuts=64 and unchanged source/engine bounds.

Engine construction 576,295 ms, cold emission 473,120 ms, C execution
127,113 ms, supply 2,277 ms and total check 1,418,360 ms.
13,643,456 engines were constructed. Different work/active-time clock inputs
do not yield a speedup comparison. /init is announced, but PID 1/root mount/
shell/tooling and browser acceptance remain unachieved.

## Admission policy is not compiled transfer identity

Inspection disproved a proposed cause: ordinary guest writes already
invalidate only exact guarded source extents. The before-write observer,
including page-table A/D aliases, must remain intact.

A separate red exposed request-policy duplication. One immutable one-
instruction transfer admitted with cap 8 could not be reused with cap 1,
although it had the same source/physical owner, binding and function. A full
64-row working set consequently could need different rows solely for budgets.

Let I be a row's actual instruction count, P its original admitted cap, and L
the current demand. The implementation uses the conservative rule:

```text
same admitted executable context and physical source extent
and I <= L
and (L == P or I < P)
```

I <= L protects the source-instruction bound, including an interrupt shadow.
The last condition conservatively retains exact policy matching for rows
that used their whole owner cap; it is not a claim the compiler found a
maximal slice. A trusted constructor can emit a shorter fixed transfer than
its owner allowed. No future body is reconstructed or inferred.

Lookup keys now exclude P and still compare the exact entry and physical
owner. The longest admissible existing prefix wins; ties prefer the larger
original cap. The last successful demand retains L independently of P.
The C execution owner uses that current policy, while explicit rebind of an
older owned row retains its existing admitted cap. Both rewalk MMU/context
before execution; neither selects different code or an execution fallback.

Only one fixed demand word is added. Sources stay at 64 rows; metadata
6,880 -> 6,888 bytes. The arena boundary stays 77,824. No source payload copy,
new history, row-quota increase, decoder or interpreter is introduced.

## Red and source-owner verification

Before changing ownership, the native budget test failed and the old frozen
VM still returns a cold miss for the new cross-budget C-Wasm model.

- 4,096 demands over a full 64-row working set alternate caps 1/8/1024,
  retaining the same slots/bindings and valid rank set without reconstruction.
- Saturated long-prefix rejection, miss/refusal immutability, source writes,
  mapping/generation/tail changes and latest-demand invalidation remain checked.
- Existing 100,000 replacement cases and 20,000 independent timestamp/LRU/
  write/reset reference cases pass with the new predicate; timestamps are
  test-only and not production state.
- [C cohort receipt](2026-10-06-budget-cohort-green.json): a current cap 1
  executes one source instruction and stops before an already owned two-
  instruction prefix. Re-admission at cap 8 executes that exact prefix.
  CPU, retirement and source-demand masks are checked, not only final RIP.
- The former shadow test expected an artificial cache miss. It now verifies
  that the first one-instruction body consumes inhibition, each subsequent
  fetch is revalidated, and all 99 retirements/full CPU/flags/shadow values
  agree. Generation/context/debug refusals remain unchanged.
- The crossing/NX test initially revealed an overstrict new bind rejection.
  It was removed: explicit retained-row binding must reach the existing
  execution MMU fault boundary, not silently change #PF into a bind error.
- 536 actual cold source emissions, 512 cold + 512 hot complete-state C
  dispatch comparisons, physical alias/A-bit, fault/wait/remap/grow/rebind and
  private-slot checks pass. These are fixtures, not Linux/browser acceptance.

Full native VM checks and all VM-core ASan/UBSan checks pass, including source,
memory and MMU. Wasm entry/host/browser are not native sanitizer coverage.
The unchanged-bundle short diagnostic reaches 1,617,931 retirements and the
independent 86-instruction CPU checkpoint. It is not a cold shell or paired
speedup claim.

## Whole-byte shifts are the existing coordinate rule

For a 16-byte vector and saturated count c=min(imm,16):

```text
right: output[i] = i+c < 16 ? input[i+c] : 0
left:  output[i] = i >= c   ? input[i-c] : 0
```

c=0 is identity; c=16 is constant zero. These are region translation/cut and
zero-default, not a guest lane loop, a decoded-opcode callback or another
format. The same x86 projection owns the law and validation. The same Wasm
projection emits one shuffle over old/zero inputs, or no payload read for
identity/constant. Its descriptor extent does not grow.

The shared check now covers 11,270 decoded projection laws: existing
permutations plus both directions, all 256 immediate values and all 16 XMM
targets. The old frozen compiler remains red at the first new byte-shift
form 432, status -102.

The [vector receipt](2026-10-06-byte-region-green.json) records 464 native/
cold byte-identical emissions, 59,392 unchanged native observations in direct
and C dispatch, 118,784 RF comparisons and 2,048 all-count/byte-region models.
Fault comparisons reuse the same 19,568 native frames across four executions;
they are not four independent oracle populations. Native x86 is executed in
the reference build VM, not claimed physical hardware. CR0/CR4 are models.

Full x86/postlink/Wasm compiler/CLI and instrumented shared-core/native
sanitizers pass. No expected observation is weakened and no scalar alternative
is selected when standard SIMD is absent.

## Candidate identity and remaining work

VM: 70,796 bytes (+297), SHA-256
`d1ac118bc52bc19cf17c858c3dbd638c28bb96453a1264b7b20720f7ed56f879`.
Compiler: 456,722 bytes (+356), SHA-256
`3a4d86de099973e6d573fa61ae6cb7f918077b1867c6b110f91cea9eb1cb60d2`.
Neither was loaded in the completed 3147e94 receipt above.

The same-bundle full candidate needs measurement. Scalar block-SSA adoption,
whole-ELF/function/dispatch closure, legacy web/catalog retirement and the full
browser development/storage/network goal remain open. Cold shell three
seconds is not achieved. Native publication and human UI are unchanged.
