# Exact Worker FS application, selected low-address profile

## Scope and owners

This is an additive part of the explicit Linux Node22/24 managed caller, not a
migration of the default Kernel, general arch_prctl/thread/signal compatibility,
or an ordinary BusyBox/shell/terminal success claim. Shared guest mm/clear-tid and canonical-source sendfile remain separate gates.
The later open(2) normalization is covered by [OPEN-CALLER.md](OPEN-CALLER.md). The later selected single-task registration/group-exit contract is in
[TASK-CALLER.md](TASK-CALLER.md).

Rust accepts syscall158 only for exact ARCH_SET_FS0x1002 and a base in0..u32MAX.
The base is a register value, not a dereferenced pointer or Memory byte-span:
values beyond the current physical extent are not rejected as pointer faults.
Other operations/high bases stop as explicitly Unsupported, not invented Linux
errno or a request for fallback into the TS Kernel. This is a deliberate selected
fixed-low-address translation profile, not normative high-address Linux behavior.

The actual Worker path uses private Linux ABI7's sequenced entrance. Rust owns
every request's snapshot, invocation and monotone1..i32MAX sequence before
operation admission. A request passing the common owner/phase/pending/sequence
checks consumes that sequence, including Unsupported or capacity failure, and
cannot be replayed. The old unsequenced diagnostic entrance retains its previous
operations but never admits FS application. IDs/sequences are scoped identities,
not security credentials against an arbitrary hostile embedding.

A register pending owner retains the exact requested base and one non-byte
Domain.effect(binding,1). It uses the same bounded arena and sole issuer as
spans/changes. Admission creates no successful guest result. Start validates the
exact owner, sequence, action and base and consumes permission before dispatch.
The pending call and Effect independently prevent a new guest call/image reuse.
Generic start/receipt/retire exports cannot bypass this operation owner.

## One paused request, one physical subround

The guest architectural FS register is represented by a Wasm Global; this never
changes the Node host thread's native TLS register. The actual instance and its
non-shared i64 fs Global live inside
`runtime/host/node/guest.ts`. The guest syscall import is blocked in Atomics.wait,
so a normal Worker message handler cannot perform the requested update.

The private112-byte channel preserves its original request fields and adds an
action/base/outcome journal. The subround is:

1. Rust admits the exact request and grants one register start.
2. The parent validates that same pending request object/invocation/sequence,
   publishes action/base and APPLY_FS, then wakes the paused import.
3. The Worker validates identity and consumes apply permission before using its
   captured built-in Global setter on its own instance.exports.fs. It does not
   decide a syscall number, errno, FD, credential or guest path.
4. The Worker journals an outcome and ACK, but remains paused. It cannot apply
   twice to the same request. A main-realm Instance/Global is never a substitute.
5. The parent checks exact ACK identity and journal, then attempts one matching
   Rust receipt. Only Rust Return0 permits the existing final RETURN to the guest.

No Global or channel escapes the facade. The built-in setter is synchronous and
does not copy guest memory. A private register command still has scheduling,
notification and state-machine work; this is not a zero-cost or universal
synchronization lower-bound claim. No new physical register hook is public.

## Evidence, loss and stopping

- AppliedStopped means the actual setter returned and access ended. Rust may
  finish the pending call and return0 only while still Running and not closed.
- NotAppliedStopped is used only for pre-setter validation failure such as missing
  or i32 fs. It settles0 and closes admission, never successful guest continuation
  or an invented Linux errno.
- A setter throw (including an immutable i64 export) or uncertain dispatch is
  conservatively Unknown. Cancellation/Unknown closes admission and retains the
  action, binding and pending call. Duplicate start cannot replay it.
- Matching late Stopped evidence may retire its exact obligation, but cannot
  resurrect guest success after closure, cancellation or fault.
- Observed Worker exit settles the physical subround promise as Unknown if its
  receipt was lost. It destroys the private Global, but does not prove whether
  that Global was written. It is not fabricated confirmed0+Stopped evidence.
  This version deliberately has no TargetDestroyed shortcut: the Rust owner may
  remain quarantined, retaining its table/context and binding after actual exit.
- A stop request, terminate Promise fulfillment, callback settlement and observed
  Worker exit are distinct. `workerEvidence.resourcesRetired` remains false for
  the Unknown case even when exited=true and pendingRequest=false.
- If Rust accepted AppliedStopped but final RETURN publication was lost, no
  syscall/setter is replayed. After actual exit the known owner can retire. Lost
  transport diagnostics do not roll back the physical update or imply guest success.

## Counterexamples and limits

Native owner tests cover unsequenced/high/other-operation rejection, zero and
beyond-extent bases, sequence/capacity consumption, stale action0, exact/foreign/stale
start and receipts, cancellation, Unknown through fault and late once-only cleanup.
ABI probes use valid owner/action IDs to exclude generic completion and all new
exports during another owner's exact pathname input view.

`node-register.test.ts` uses self-contained Wasm and a real Worker, no main-thread
Instance. Shared progress remains unchanged while each applied ACK is held, then
records two distinct actual fs values after final replies. It separately covers
clone/stale/duplicate/foreign requests, missing/i32/immutable Globals and actual
termination settling an outstanding subround. These are transport tests, not Rust
or Linux syscall evidence.

`managed-register.test.ts` builds one raw-syscall static ELF, runs it natively and
through the actual current translator/core/Worker, and compares two `%fs:0`
sentinel writes and status. A main-instance-only update cannot pass that test.
Isolated child injections lose an applied ACK before Rust receipt or lose final
RETURN after Rust receipt. Neither resumes guest output or replays. The first
retains Unknown resources after real exit; the second returns the sole table for
another actual prepared Worker. There are no production fault hooks.

Full strict TypeScript, remote CI and new-head browser6MB remain independent gates.
This selected successful register caller does not complete ordinary cat or root
shutdown, implement GET_FS/SET_GS, Linux address/error precedence, futexes, threads,
general signals, mutable mappings or terminal behavior.
