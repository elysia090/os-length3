# Opt-in C source profiling — 2026-10-06

## Actual completed result

The [completed a305af4 receipt](2026-10-06-node-startup-service-timeout.json)
passes the PSRLDQ entrance. It retires 265,612,366 source instructions /
149,485,773 supervisor admissions. The guest reports:

```text
s6-ftrigrd: fatal: unable to sync with client: Broken pipe
s6-rc-init: fatal: unable to supervise service directories in /run/s6-rc/servicedirs: Operation timed out
Offline service transition failed; terminal remains down.
```

After that failure, compiler -102 is HLT `f4` at
`0xffffffff813efa53`, followed by CLI/RET. This is not a working shell,
browser acceptance or a successful distribution boot. Guest service code,
timeouts and clock policy were not relaxed to make it green.

Engine construction 725,454 ms, cold emission 595,693 ms, C execution
158,080 ms, supply 2,266 ms and total check 1,764,466 ms dominate.
The frozen compiler/VM are 456,722 / 70,796 bytes. Source rows remain 64;
module-cache bounds and warmCuts=64 are unchanged. Different source work/
active-time clock inputs do not supply a speedup ratio.

## Measure the missing lifetime distinction

The normal source owner already invalidates only exact guarded source bytes
before physical writes, including page-table A/D aliases. It does not revoke
all code on every RAM write. A request-budget mismatch was separately removed,
but that alone did not remove the real cold/engine construction dominance.

The next action is to classify it, not guess or increase cache quotas.
The profile build counts exact supervisor queries, cold reservations, full-
owner replacements, write-revoked rows and pending write cancellations.
Every 4,096th successfully C-MMU-admitted supervisor query samples the bounded
valid rows and classifies absent entry, remapped first physical owner,
budget rejection or an admissible first-page candidate.

A reusable first-page sample can still need a crossing tail, whose exact
permission/residency/physical identity check remains mandatory. Periodic
samples are descriptive; they are not an unbiased population estimate or
complete future closure. These counters do not record guest bytes or expand
an event history.

`VM_SOURCE_PROFILE` is opt-in. Use:

```powershell
./data/oracle/wasm-tools.ps1 -Profile -Output temp/source-profile/vm.wasm
```

The same product Makefile compiles it. The SDK helper forces this small
standalone rebuild so changing flags at the same output path cannot retain a
stale mode. A compiler profile request is refused: source ownership is the VM
boundary, not another compiler/runtime path.

Generated cuts do not import the privileged getter. The counters are outside
guest CPU/semantic identity and cannot authorize code, change policy, refresh
a source or hide a fault. The profile write observer calls the same existing
C invalidator before recording its removed rank mask. Its function-table slot
is included in the protected C slot floor.

## Verification and preliminary scope

Six controlled C-Wasm models prove exact counters for absent/reusable/budget/
remapped candidates, writes/pending cancellation and full-owner replacement.
CPU state and source bounds remain checked. The
[cohort receipt](2026-10-06-source-profile-cohort.json) contains these models
plus the existing source/permission/fault/continuation/shadow controls.

The profile build also passes 536 real cold emissions, 512 cold + 512 hot
complete-CPU dispatch comparisons, crossing NX/nonpresent/physical owner,
exact writes/A-bit aliases, pinned cancellation, remap/grow/rebind and private
table-slot controls. These are fixtures, not native/Linux/browser performance.

The [short-prefix receipt](2026-10-06-source-profile-prefix.json) preserves
the independent 86-instruction CPU checkpoint and reaches 1,617,931 source
retirements. It observes 1,000,000 supervisor queries, 1,770 cold reservations
and 1,706 full-owner replacements. All 244 periodic samples in that early
population are reusable, with 64 valid rows; write revokes/cancellations are
zero. That early repeated decompression population does not classify the
later kernel/user/service hot path. A same-bundle full profile is required.

Normal VM SHA-256 remains exactly
`d1ac118bc52bc19cf17c858c3dbd638c28bb96453a1264b7b20720f7ed56f879`,
70,796 bytes. The opt-in module is 71,504 bytes, SHA-256
`3c9c71891e38238f6f46b3e9782042a7efa3297a2ed81c8d06ce2cf47859cabf`.
Normal source metadata/capacity, compiler, native release and human UI are
unchanged. Node engine/model results are not actual-browser observations.

## Next work

The [completed full opt-in profile](2026-10-06-source-profile-full.json)
retires 266,180,192 instructions / 150,000,000 admissions, reaching the
unchanged diagnostic admission cap. It records 85,581,906 cold reservations,
85,581,842 full-owner replacements, 36,621 periodic samples: 20,900 absent,
15,721 reusable, zero remapped-owner/budget rejection. Sampled valid-row sum
2,343,744 is exactly 64 times the sample count. No currently retained source
row was write-revoked and no pending compilation was write-cancelled; these
counters do not imply absence of guest RAM writes or future code mutation.
Engine/cold/execution elapsed is 703,894 / 598,602 / 162,175 ms, total
1,760,260 ms. The diagnostic says `pass`, but `linuxBoot: not-achieved`;
console ends in s6-ftrigrd Broken pipe, not a usable terminal. Same frozen
compiler/profile VM and quotas as above. Session 60635 / child 13512 ended
normally. Instrumented timing is not a paired performance improvement.

Remove demanded coordinate/body reconstructions through shared normalized
layout and bounded physical delivery/lifetime, not a larger cache quota or
analysis-only acceleration. A [separate HLT candidate](2026-10-06-halt.md)
now supplies exact retirement/idle/wake without a kernel wait skip; it was not
in this completed profile. Investigate the actual service/IPC/scheduling/timeout
failure under the existing explicit clock contract. Preserve the same accepted
bundle; no fake POSIX, another interpreter or softened success condition.

Whole-ELF/function/dispatch closure, block-SSA backend migration, old web/catalog
retirement, Linux PID 1/offline development, authenticated storage/recovery,
granted networking/browser service use and cold shell three seconds remain
unachieved. The full product goal stays active.
