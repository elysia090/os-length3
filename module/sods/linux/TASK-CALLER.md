# Single guest task registration and group exit

## Selected context, not a general PID namespace

The managed caller gives each execution a fresh, private engine Memory, one guest
runner and one guest task/thread group/mm. Its execution-local task identity is
TID/TGID1. This is not a domain-global PID namespace, Node Worker ID or execution
number. Independent executions may each have identity1 because they are distinct
isolated task contexts. getpid/gettid/clone/fork/wait and shared guest mm are not
implemented by this unit; adding them must first preserve or replace this scope.

Physical SharedArrayBuffer views in the parent/Worker transport do not make a
second Linux guest task. The actual fresh/private-Memory caller and absence of a
guest mm-sharing route are the proof, not just duplicate numeric binding checks.
The raw private ABI still trusts its embedding to register physical memory
honestly; it cannot discover aliasing from unrelated numeric IDs.

## Registration is owned state, not a guest-memory operation

Sequenced syscall218 captures the complete u64 clear_child_tid pointer and returns
the Rust-owned local guest TID. It neither dereferences, aligns, truncates nor
range-checks that pointer. NULL, high, invalid and unaligned values remain values.
Re-registration replaces only that task's record. No lazy loader, guest byte span,
physical Worker register command or extra Domain action is needed for this pure
Rust transition. Unsequenced diagnostics remain explicitly Unsupported.

A private SingleTask inside the Continuation retains its initial full Snapshot:
domain/execution/image/binding. Both registration and group-exit admission require
that exact snapshot plus the active invocation's syscall permission. Installed
raw-diagnostic reimage cannot reuse the old task; it fails closed. An Untouched
image attempt preserves the original snapshot and record. Future per-syscall
Continuation recreation would require moving this longer-lived task owner into
the execution resource holder, not resetting it on each syscall.

Private Linux ABI6's read-only task-registration observer makes the full pointer
and local TID directly verifiable, including after unwind/fault before retirement.
It grants no pointer access, does not appear on the managedRoot facade, uses the
exact retained image/binding identity, and is excluded during live core input/read
views. Retained identity is not new run/syscall admission. It rejects a changed
image and rejects after the Continuation has retired. This prevents representing
registration as an unobservable success-only stub or a test-only field.

## Why this scope does not clear a guest word

The Linux man-pages project describes pointer registration separately from an
exit-time zero/futex wake conditioned on shared memory. Its raw exit and exit_group
interfaces also distinguish one task from a thread group.
[set_tid_address](https://man7.org/linux/man-pages/man2/set_tid_address.2.html),
[raw exit](https://man7.org/linux/man-pages/man2/_exit.2.html),
[exit_group](https://man7.org/linux/man-pages/man2/exit_group.2.html).
The reviewed upstream implementation gates the clear/wake path on mm user count.
[upstream fork.c](https://github.com/torvalds/linux/blob/master/kernel/fork.c).
These source observations are not a claim that upstream master exactly matches
the cloud host's kernel tag.

Controlled native probes on one Linux6.18.57/x86-64 host separated MAP_SHARED
mappings across fork's different mm from CLONE_VM tasks sharing one mm but not a
thread group. All46 registrations returned their task's gettid value without an
immediate word change. Separate-mm targets stayed unchanged after raw60/231;
shared-mm final valid targets became0, with old targets unchanged on replacement.
The selected caller has exactly one guest mm user, so it intentionally performs
no guest clear-tid store or futex wake. This is a condition-derived case, not an
always-success no-op for shared guest mm. Sharing guest mm requires a new task/mm,
clear-store and wake ownership/physical-receipt protocol before admission.

The native experiment also observed shared-mm clearing after its own child's
SIGKILL. Therefore it does not support an unconditional “signal exit skips clear”
rule. Futex wait/wake delivery, CLONE_THREAD and general signal semantics were not
verified. Its34 children were reaped without timeout;102 fixture checks describe
setup/report/exit control, not34 portable syscall-semantic pass labels.

## Exit request, unwind, physical stop and metadata drop

Sequenced231 uses the existing Execution.request_exit and StepExit under the
single-thread-group guarantee. Status uses its low8 bits. Neither registration
nor the exit request clears the stored pointer or proves guest/Worker termination.
Unsequenced231 remains Unsupported. Existing60 behavior is unchanged.

The record stays through abandon, final-reply loss, requestStop and run unwind.
Only the containing execution's normal resource retirement drops its Continuation
and SingleTask. The selected Node adapter requires actual Worker exit before that
retirement, and Rust still checks every independent pending source/copy/stream or
Unknown obligation. This unit weakens none of those conditions. An exit-group
request whose LEAVE publication is lost must report failure, not its requested
normal status, and must wait for actual exit and ordinary cleanup.

## Counterexamples and remaining gates

Native Rust/ABI tests distinguish full-value capture from memory access, local
identity from foreign/reimaged owners, observer from admission, sequence gaps and
duplicates, pending calls, Untouched versus Installed images, post-unwind retention
and disappearance at resource retirement. Valid-ID observer probes exercise exact
core-view guards rather than relying on an invalid ID failure.

The actual current-source Worker fixture re-registers valid/NULL/high pointers,
checks sentinels are untouched, and exits via231. The same raw-syscall ELF runs
natively: fixed output bytes and status match; its numeric TID field is checked
against the native child PID there and the declared local guest identity1 here,
not falsely compared as equal host/guest PID values. Isolated child injections
lose218 RETURN or231 LEAVE twice, prove no replay/no successful exit claim, and
then really run a fresh control using the sole returned table/context.

This does not complete ordinary cat. The later open(2) route is covered by
[OPEN-CALLER.md](OPEN-CALLER.md); owned canonical-source sendfile,
shared guest tasks/futexes, general process/signal/VM/TTY behavior, full root
shutdown and new-head strict TypeScript/CI/browser6MB remain separate gates.
