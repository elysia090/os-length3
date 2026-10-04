# Independent clock progress at a C cut boundary — 2026-10-04

The [actual browser receipt](2026-10-04-boundary-clock-browser.json) passes
the previous pure counter wait without changing the kernel, its counters,
instruction retirement or command line. Linux's normal interrupt handler
advances guest time. The console proceeds through delay-loop calibration,
CPU identification and mitigation setup. The next refusal is `DB E3`
(FNINIT) at `0xffffffff81034ca3`, not the old timer quota.
PID 1/shell remains unachieved; this diagnostic pass is not successful boot.

## One clock frontier, not a second timer implementation

`vm_clock_poll` is a supervisor-only API; emitted guest functions cannot
import it. At a completed cut boundary it uses the existing C clock owner,
reserved continuation key, generation, nonwrapping ticket and monotonic
timestamp. Request -> exact reply -> matching poll retry consumes the event.
CPU state is neither copied nor retired. Clock owner size remains 88 bytes.
C PIT/PIC, RTC and UART advance through the existing common commit path.

Pending instruction, source admission, page/fault/table/console frontier and
memory reservation refuse a poll. Pending boundary-clock acceptance blocks
new source admission/execution until consumed. Rebind cancels both pending
and acknowledged tickets, preserving issue high-water and device time;
close/open resets device time without ticket reuse. Exact duplicates are
idempotent only within the current owner/port/generation/ticket/time frontier.
Two exposed reds were fixed: wrong-port duplicate acceptance and acceptance
of an acknowledged ticket after rebind.

This startup diagnostic polls after at least one millisecond of measured C
execution since the last accepted clock sample. Compilation, supply and UI
stalls are paused. Guest-requested IN/OUT/RDTSC clock samples use the same
acceptance helper. This is an explicitly declared virtual-clock policy, not
an instruction-count clock, physical-clock calibration or wait-loop summary.
HLT wake, interruptible partial REP and complete timing/device semantics
remain separate obligations.

## Validation scope

* Native C clock: 18,442 boundary/duplicate/cancel/generation/refusal
  observations; four generations including the high bit and maximum value,
  alternating private ports and ticket exhaustion. No full CPU snapshot in
  the product; full snapshots here are test observations only.
* 3,200 generated pure self-loop cuts followed by 32 PIT-clock boundary
  IRQ/IRET frames; no extra source retirement on clock acceptance.
* Private-port, stale timestamp/ticket/generation/RIP, source pin, matching
  retry, duplicate, rebind and same-generation reopen assertions pass.
* Existing 768 privilege/IF/shadow cases, 288 #GP cases, 96 IRQ cases,
  32 guest-time PIT IRQ cases and 192 independent system observations remain
  green. QEMU saved-RF discrepancies are explicitly excluded; the new
  supervisor-clock source is model-tested, not claimed as a silicon oracle.
* Full product checks and all linked C VM-core ASan/UBSan checks pass.
  PIT/UART, native/cold register parity, precise memory/RF and bounded-engine
  reuse regressions pass separately.

```sh
make -C src/v2/vm clock-check
make -C src/v2 check
node data/oracle/check-interrupt-provider.mjs VM.WASM COMPILER.WASM SYSTEM-ROWS.txt
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM FIXTURES --extended
```

## Actual run and build identity

138,929,830 retired / 70,626,112 admissions; 5,388 accepted Linux console
bytes, 49,100 clock events including 34,820 independent polls, 468 IRQs,
zero deferred polls. Complete 14,622,864-byte decompression remains identical.
The browser used the first clock-poll build, before the later acknowledged
ticket/rebind fix. That last fix changes cancellation validation only; its
final build passes the lifecycle regression, not relabeled as this receipt.

```text
observed VM 57,817 bytes SHA256 4a4342896182fa365272720f179519ca4a6f165753c732e9fb3a6141a724c738
final VM 57,824 bytes SHA256 4e5cc71b2755df59600d76f384421f6e7f69f11aa0d133ac4f6e020d561d812b
compiler 431,456 bytes SHA256 9ac91e8c2bfb54a7233033081384900289e969a60e416b289c76a9d2916594a7
bundle SHA256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

C execution 36,650.6 ms, engine 78,284.7, cold emission 24,600.8,
admission 23,497.1, supply 226.5. Timer handlers add source/cache churn;
these are phase measurements to a new refusal, not comparable shell times
or a claimed speedup. Source copying is 9,837,498,368 cumulative bytes,
not retained RAM. 742 retained emitted witnesses / 261,955 bytes are not
total engine RSS. Ordinary browser memory, no cross-origin isolation and
no signed-production-root claim. Calibration/MSR warnings remain visible.
Native release and human UI are unchanged. Cold shell 3 seconds is unmet.
