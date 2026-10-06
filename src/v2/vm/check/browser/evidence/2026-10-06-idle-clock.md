# Least idle clock deadline and real host wake transport — 2026-10-06

Candidate against `d37c8a6`. The last completed full same-bundle run stops at
a correctly retired HLT after s6 Broken pipe/timeout. Its diagnostic has no
idle-time transport. This candidate connects that missing event boundary;
it does not claim the service failure, whole-ELF closure or browser goal fixed.
Native publication, human UI and retained browser Workers/assets are unchanged.

## Derivation from the required observation

While a serialized CPU is halted, guest code cannot alter timer programming,
PIC masks or in-service priority. A masked/inhibited timer cannot wake it.
The next relevant observation is therefore the minimum eligible IRQ assertion,
not the next oscillator tick or every missed period. Unobserved elapsed work
remains in existing PIT/RTC/UART residual state; their existing O(1) advance
handles it when a clock event is actually accepted.

For frequency `F`, origin `o` and target tick `k`, substitute `k=qF+r`:

```text
T_F(ns-o) = floor((ns-o) F / 10^9)
D_F(k,o)  = o + q 10^9 + ceil(r 10^9 / F)
T_F(D_F-o) >= k
T_F(D_F-1-o) < k                         (k > 0)
```

`D_F` is the least integer nanosecond reaching that tick. Before addition,
check `k <= T_F(UINT64_MAX-o)`. No full-width `k*10^9`, tick scan, overflow or
floating-point approximation is needed. One private inline definition is used
by both device owners and independently checked at both neighbours.

* PIT IRQ0: pending initial load/restart needs one loading pulse plus reload;
  otherwise the next rising edge is `anchor + count - elapsed`. A stopped gate,
  paused mode-0 partial write or completed one-shot has no future edge. The
  existing mode-0/2 population is preserved; other modes remain unsupported.
* RTC IRQ8: periodic tick rank rounds to the next period. Update-end uses
  `now + 10^9 - fraction`; alarm uses the existing closed lexicographic alarm
  function. Enabled source flags and SET/oscillator/calendar limits determine
  which candidates exist. An already asserted IRQ needs acknowledgement, not
  repeated host polling.
* UART IRQ4: only an enabled, not-yet-asserted FIFO timeout contributes its
  existing four-character deadline. No new UART or guest input semantics.
* PIC eligibility uses the same existing mask/rotated-service priority grant
  function as actual pending arbitration, plus the existing master/slave wire.
  It neither copies nor asserts/acknowledges a hypothetical device owner.

The minimum is a read-only projection. The PIT/RTC/UART/PIC/clock owners retain
their old sizes; there is no per-tick history, calendar image, callback list or
new CPU snapshot. [QEMU's PIT source](https://raw.githubusercontent.com/qemu/qemu/master/hw/timer/i8254.c)
schedules its computed next transition and drives IRQ at that event. Its
[RTC source](https://raw.githubusercontent.com/qemu/qemu/master/hw/rtc/mc146818rtc.c)
also owns device timers. Those are architectural comparison material, not
product dependencies or copied implementations.

## The single event boundary

`vm_idle_clock(port,generation)` requires a genuine halted activity and no
pinned fault/page/IO/console/source/reservation. It reports an already pending
eligible event without a host delay; IF/shadow/masks/no future event retain
HALT. Otherwise C writes its deadline in the ordinary private port value and
issues the existing boundary-clock ticket. No new ticket authority or packet
parser is introduced.

The halted RIP remains pinned until that exact generation/ticket/RIP clock
reply is consumed. Duplicate replies are idempotent. A reply one ns before
the deadline does not wake; retry produces a new ticket for the same remaining
boundary. Close/rebind rejects old replies even within the same generation.
Fresh Worker outer scopes still require a non-reused broker generation; this
candidate does not establish that broker/recovery integration.

`web/idle-clock.mjs` transports the C deadline with cancellable standard host
timers and measured `performance.now()` duration. It interprets no guest
device, opcode, branch, IRQ, syscall or pathname. Early callbacks cannot
invent time; late callbacks are coalesced by C. The signed 32-bit timer limit
is chunked without overflow; u64 timestamp exhaustion refuses. Every settled
or aborted wait releases its host timer/listener, including falsy abort reasons.

The shared startup diagnostic accepts an explicit idle transport. Its Node
CLI `--idle` selects the same browser-compatible helper. Before choosing a
deadline it accounts for the retiring HLT's measured C execution. Its clock
is active C execution plus measured idle time; compilation/delivery stay
paused, rates/timeouts are not relaxed. The finite diagnostic idle-event bound
is not successful boot. Browser transport selection/actual-browser observation
and production Worker integration remain unverified.

## Verification, not Linux acceptance

[Candidate receipt](2026-10-06-idle-green.json):

* Native VM checks pass. Tick inverse tests cover four frequencies, three
  origins, neighbours and the complete u64 endpoint. Existing PIT 599,808
  pulse and 25,728 batch observations additionally check future edges. PIC
  147,456 grant observations and slave masks check the same priority law.
  RTC 1,536 deadline phases check no IRQ at `D-1` and IRQ at `D`.
* Scoped native ASan/UBSan rebuilds clock/device/execution owners and passes
  their checks. This is not a Wasm-engine sanitizer or silicon fidelity claim.
* Old VM is red: `vm_idle_clock` absent. New C-Wasm PIT/RTC waits, masked/IF
  refusals, exact-neighbour event timing, duplicate/stale/cancel/rebind checks
  pass. A real host timer reply wakes the C CPU through PIT/PIC/IDT without
  guest work during host sleep. This is a model, not privileged native REP or
  browser Linux boot.
* Existing 224 independent system shadow/IRQ/HLT records, source admission,
  warm cohort and C PIT/PIC/RTC/UART provider regressions remain green.
* Same published bundle's short diagnostic preserves its independent complete
  86-instruction checkpoint and reaches 1,617,931 retirements / 1,000,000
  admissions, then its old quota. No HLT/idle event occurs in that prefix.

```text
compiler.wasm unchanged 457,318 bytes
4a5cf5dada7e2d3014c5f5be499c5271a40c7b8063ac957fd6f5ada226ca8c64
vm.wasm 81,547 bytes
0a8ee799638de906a4d87e4496e7be25ee4e46241882bc5de71b6dc8d34777b4
```

The real full Linux job must verify the next barrier and s6 readiness. A
passing event fixture does not establish PID 1/offline terminal, development,
authenticated storage/recovery/network or cold shell three seconds. Whole ELF
still refuses -104; source/engine residency and scalar normalized SSA backend
obligations remain. No release-size or Linux speed improvement is claimed.
