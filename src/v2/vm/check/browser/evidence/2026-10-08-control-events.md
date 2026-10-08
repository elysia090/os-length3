# Every software vector and the waiting cut — 2026-10-08

The same published make's complete 233,455-byte PF_X domain improves from
1,031 to **745** unresolved coordinates: **170 INT + 116 FWAIT** recovered.
There are 232,710 lowerable coordinates and zero fault/fetch/capacity refusals.
The input is still the unchanged 339,960-byte native bundle ELF, not a
substitute program. Source admission is not a Linux boot or publication claim.

## One event and one pending-exception owner

CD imm8 now takes the checked software-event law for every vector. F1 and CC
share that law's extent and effect checks, but F1 has an explicit debug-origin
bit. Low eight bits select the vector; bit eight is valid only with vector 1.
Consequently CD 01 retains IDT DPL checks and DR6/GD, while F1 bypasses DPL,
sets EXT on secondary errors and has the independently observed debug effects.
No instruction bytes or host handler addresses cross the C event interface.

All software events have five frame words, including INT 14 and other vectors
that also name hardware exceptions. Processor #MF/#XM delivery is now admitted
and has no error-code word either. The former `vector >= 10` slot predicate
was wrong: only accepted error-code faults 10..14 and 17 have a sixth word.
Intel's [interrupt and exception contracts](https://cdrdv2-public.intel.com/835754/253668-sdm-vol-3a.pdf)
define this separation; successful software delivery retires once, a failed
delivery does not become successful execution.

The event's vector occupies the previous four padding bytes in the existing
**168-byte** delivery frontier. A retry cannot substitute another vector of
the same event kind. Completed frame writes and consumed descriptors remain
pinned across page waits; no snapshot, second frame generator or interpreter
was added. The F1/INT ABI meaning changed, so machine-entry version is **4**.
The C authenticated module owner rejects version-3 module descriptors instead
of adapting an old F1 body into an ordinary INT 1. The four-argument function
type, state extent and source-row layout remain unchanged. Diagnostic/browser
entry checks were updated, without changing the human UI or native release.

FWAIT is a separate precise instruction, not a prefix fused with FNINIT.
Its #NM condition is **CR0.MP && CR0.TS**, independently of EM. On success it
does not publish FPU IP/FOP, change tags/TOP or perform a numeric operation.
The existing pending-exception guard supplies #MF when NE=1 and the C FERR/PIC
owner when NE=0. That owner now accepts FWAIT's valid EM and TS/!MP contexts;
the former ordinary-x87 EM/TS admission would incorrectly reject them.
See Intel's [WAIT/FWAIT instruction contract](https://cdrdv2-public.intel.com/789589/334569-sdm-vol-2d.pdf).

## Independent observations and active product checks

The existing `debug-entry.S` boot/GDT/IDT scaffolding includes generated native
gate stubs for all 256 vectors. These stubs identify the actual processor
event; they do not predict a result or implement product execution.

Explicit WHPX produced **1,152** independent rows:

- 1,024 INT rows: every vector, interrupt/trap gates, RF contexts and varying
  stack alignment. All five frame words, handler flags/RSP and debug status
  match the actual cold C compiler -> generated Wasm -> C event owner.
- 128 FWAIT rows: eight prefixes, MP/TS/EM combinations and pending/no-pending
  errors. There are 48 successes, 32 #NM and 48 #MF. Successful WAIT preserves
  the captured CW/SW; #MF/#NM frame delivery matches C with no error slot.

This is virtualized system observation, not a universal bare-metal guarantee.
Other-GPR invariance is architectural; the independent oracle observes frame,
debug and FPU fields, not every register of every guest program.

Native C emission/cold-C byte parity covers **2,064** forms and **24,768**
malformed-law controls. Through direct calls and the actual C function table,
the software-event driver passes **264,192** complete CPU/frame models,
**16,512** page-wait/retry models, **24,768** delivery faults and **14,448**
private-entry/generation refusals. This includes INT 1 with GD retained, not
the F1 effect disguised as an expected model. Deferred lower frame stores
retain their already-read gate; corrupting it cannot force a replay.

FWAIT has eight constructor forms/96 malformed controls and **768** complete
state runtime comparisons. Those cover MP/TS/EM/NE, masked/pending statuses,
direct and C-table entry: 192 #NM, 96 #MF, 96 FERR waits and 384 successes.
These are model rows, kept separate from the independent system observations.
The previous F1 normal/failing-delivery 768+768 system populations remain green.
VM checks, targeted compiler/module checks, postlink checks and positive
ASan/UBSan pass, without warnings in the final scoped run.

The unrestricted full `make check` also exposed the previously documented
intermittent CALL payload red (form 0/row 17), and one store-ordering observation
in an earlier run. These independent reference results are retained; they are
not normalized to green by retries or used to change guest semantics. Thus
this checkpoint does **not** claim the unrestricted full gate is uniformly
green. The [prior independent CALL diagnosis](2026-10-05-call-fault-windows.md)
already distinguishes RAM payload and fault-frame equivalence. It remains a
separate architectural obligation while closure-family implementation proceeds.

## Fresh products and reproduction

Compiler: 668,289 bytes, SHA256
`eaab9616ba6610e50183476ce0cd66fe9e781a033f94d44c2fa9a75ddc3287ff`.
VM: 98,252 bytes, SHA256
`aba9295efb733abb1e740da272a1128905c3d070139220f22fc20070b8f843ee`.
These are source-scope ABI-4 products, not a rewritten signed Linux release.
The same-bundle short startup regression still reaches the 86-cut witness,
1,617,931 retired source instructions and its one-million-admission quota.
That is not PID 1, shell, cold-ready time, RSS reclamation or network acceptance.

```sh
make -C src/v2/x86 all
make -C src/v2/vm all check
make -C src/v2/wasm-compiler all software-interrupt-check x87-wait-check
SOFTWARE-INTERRUPT-CHECK NEW-FORMS
node data/oracle/check-software-interrupt.mjs VM.WASM COMPILER.WASM NEW-FORMS
node data/oracle/check-x87-wait.mjs VM.WASM COMPILER.WASM
bash data/oracle/prepare-debug.sh NEW-ORACLE --control-events
node data/oracle/check-iret-system.mjs QEMU ORACLE.ELF NEW-TRACE whpx --control-events
node data/oracle/check-control-events.mjs VM.WASM COMPILER.WASM NEW-TRACE
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Zero unresolved accepted coordinates and the actual browser Linux objective
remain the gate. Next work is the remaining x87 views/transfers, SIMD families
and far control transfers, not a relaxed publication condition.
