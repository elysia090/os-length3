# Shared register updates and exact remaining population — 2026-10-06

## A real admission gap, not an opcode fallback

The new native register-update check was first RED at form 0: a legal XADD
had compiler status -102. The x86 owner now supplies one typed two-register
update law for XADD/CMPXCHG across 8/16/32/64-bit, high-byte and extended
bindings. Both native SSA and the cold Wasm backend consume this admission.
The generated execution is ordinary arithmetic/comparison/conditional
publication and existing flags, with **no new callback or interpreter**.

All old operands are captured before either write. XADD computes d+s, places
old d into s, and publishes the sum into d last; identical coordinates remove
the redundant copy. CMPXCHG compares the accumulator with d, then writes only
the selected arm. Every parent is loaded before emitting either Wasm branch,
so compile-time load sharing cannot expose an uninitialized local in the other
arm. The predicate is independent of live outgoing flags.

The Intel [CMPXCHG reference](https://cdrdv2-public.intel.com/868140/253666-089-sdm-vol-2a.pdf)
defines the accumulator comparison and conditional updates. Native observations
below establish the actual full-parent behavior; host features never widen the
fixed compiler CPU profile.

## The shared SSA had a conditional-parent defect

Selecting two lane32 values before publication erases the untouched high
half. For distinct 32-bit destination D and accumulator A, the actual transfer
is instead:

```text
E  = low32(A) == low32(D)
D' = E ? zero_extend32(S) : D
A' = E ? A : zero_extend32(D)
```

The old `1bb3e6e` x86 library is now RED on the conditional full-parent
regression (`width=32 dst=1 src=0`). The revised SSA constructs tentative
complete parent definitions and merges them with lane64 select. The alias
D==A low lane is reflexive; AL/AH share one parent with disjoint fields, not
two sequential input reloads. Narrow source values are truncated only in the
arm that actually writes; a read alone never zeroes the source parent.

The current x86 check covers 2,048 all-register forms, 1,920 conditional
full-parent definitions and malformed/LOCK admission controls. These are
structural shared-SSA checks, not a replacement for runtime observation.

A separate bare ordinary ELF checks both upper-half arms and AL/AH aliases
before and after the actual native postlink CLI. **Both the frozen old CLI and
the new CLI execute correctly**: native instruction selection retained source
for the protected updates. Therefore this is a latent shared-SSA defect, not
evidence that the published native bundle was broken or that native execution
became faster. The publication/native bundle is unchanged.

## Independent execution evidence

[Register-update receipt](2026-10-06-register-update-green.json):

* 402 forms and 25,728 pre-lowering native observations remain stable (only
  the native harness RSP coordinate is projected when comparing captures);
* 402 native-C/cold-C module byte parities;
* 25,728 full CPU comparisons each in direct Wasm and actual C-MMU/source/
  function-table dispatch, plus separate RF models;
* an independent integer/flag model agrees with all 25,728 native captures;
* 4,096 extra all-register models include RSP/SPL, which cannot safely run in
  the native return harness; LOCK positively generates #UD.

Existing source admission/cohort, counter/fault and mixed-module regressions
pass. Full x86/postlink/Wasm compiler checks pass. Postlink ASan/UBSan rebuilds
the shared x86/decoder/support/ELF providers and now includes the parent-law
check. Separate build-update-san instruments emitter/coverage/collection and
register-update checks; its provider archives are regular builds. No sanitizer
result is a real browser or Linux-boot observation.

```text
compiler.wasm 456,244 bytes
3cd9a0c6dc97f8016907e8b2af4f6910cc76de939324a220b43049e82778eaf6
unchanged vm.wasm 79,421 bytes
d51851ad4b359a35851aca74a1b53d5810f036ca71ab56bf8e4f2032e4a8ca8e
```

## Do not confuse a generic fix with the current dominant population

The diagnostic now counts stable machine-operation and x87/vector descriptor
operation bytes. It uses fixed bounded counters, not a decoded-object
population or another execution format. Histogram totals are independently
checked against total grammar misses.

The earlier suspicion that operation 46/47 meant register XADD/CMPXCHG was
wrong: the shared enum names those ENTER and STRING. The new register update
feature **does not reduce the two s6 inventories or make's inventory**. These
files contain no such remaining register-update miss. This matters to the next
action; do not report 377 removed coordinates or a Linux speedup.

The actual published `/usr/bin/make` (339,960 bytes, SHA-256
`dd0023829f36b764b9ba537a0c4965bba1d54b20beaebc5681e27ea56c25cd14`)
is queried using a separately rebuilt `1bb3e6e` compiler and the candidate,
with the same decoder vendor snapshot and exact final ELF.
[Before](2026-10-06-make-before-update-coverage.json) and
[after](2026-10-06-make-after-update-coverage.json) agree:
233,455 PF_X coordinates, 225,396 lowerable, 7,831 valid misses, 228 fault
misses, zero fetch/cap refusals. Whole-machine publication remains false.

The remaining machine groups include x87 3,343, machine-none (integer/fault) 2,457,
port-I/O 870, far return 466 and IRET 244. Within x87, memory load 353 and
quiet compare/pop 360 are large; within integer operations, ENTER 684,
STRING 730 and RET 710 remain. The first make gap is CMPSB `a6` at 0xa09e.
These are conservative all-byte populations, **not execution frequencies**.

Next close actual dominant generic x87/load/compare and string/control
families, with exact FP exceptions/precision and memory ordering, consuming
existing machine boundaries rather than guessing faults. Whole-ELF/control/
indirect/executable-generation closure, normalized scalar-SSA backend use,
compiled Artifact delivery/residency, s6 readiness/idle transport, legacy-web
retirement and actual-browser development/storage/network/cold shell remain
open. This candidate was not substituted into retained browser Workers/assets
or a full Linux run, and no release-size/performance improvement is claimed.
