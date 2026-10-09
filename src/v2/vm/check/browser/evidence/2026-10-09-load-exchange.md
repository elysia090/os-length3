# Exact small extents and common x87 load/exchange SSA — 2026-10-09

Same published make: **625 ->514 unresolved**, **111 recovered** (63 raw loads,
48 exchanges). 232,941 lowerable of233,455 PF_X-byte coordinates; fault/fetch/
capacity refusals0. Remaining x87154/vector238/far91/other31 still belong to
the unchanged full publication gate. Native bundle and human UI are unchanged.

## Existing memory owner, exact extent

The existing four-argument `read_pair` C/MMU owner now accepts **1..16 bytes**.
It performs complete rights/residency preflight and substitutes the pinned
fragments into the final low/high words. It reads exactly the requested bytes,
zeroes unused high bits and creates no temporary16-byte record or second
translation. A10-byte operand does not cause a16-byte guest read or touch the
six unrelated bytes that follow it. The ABI4 signature/port layout is unchanged;
ALIGNED16 still requires exactly16 bytes.

Every length1..16, every crossing split and success/fault/wait/stale-generation
case passes **544** C/MMU models. Poisoned output words remain unchanged on a
late fault/wait. Existing49,152 MMU permission models still pass. The generated
10-byte load reserves the existing private pair-port extent before accessing
its high word; no scalar fault-port overrun or another VM opcode is added.

## One load/push publisher

`lower-x87-integer.c` is moved to `lower-x87-load.c`; FILD16/32/64, IEEE32/64
and raw80/register FLD use the SAME pure outcome and publisher. The old source
is not a second product recipe. The construction class is now X87_LOAD rather
than an integer-only name. Raw80 and register sources retain all bits, including
SNaNs, denormals and unsupported extended patterns; they create no numeric
conversion exception. Tags reflect their physical classification.

The checked raw plan adds source emptiness to the common stack-fault predicate:

```text
stack_fault = destination_full | source_empty
overflow    = destination_full & !source_empty
IE/SF       = stack_fault
C1          = overflow
suppress    = stack_fault & !CW.IM
```

A masked stack fault pushes indefinite; unmasked invalid latches status/FOP
without pushing or overwriting a payload. **Source underflow takes priority
over destination overflow** when both predicates hold: C1=0. Actual native
comparison found that distinction; it was corrected rather than changing the
reference. The source register is captured before the push, including ST(7)
aliasing the new physical top. Empty/full register cases read no latent payload
whose result is already determined. Memory operands still receive complete
access checking before the stack result is published.

An independent native read-fault oracle gives **8** source-page/stack-priority
rows. Unreadable80-bit source causes #PF/error4 even with full/unmasked stack,
and every FPU field stays unchanged. Valid memory permits the observed masked
push or deferred unmasked stack exception. This is actual reference-build-VM
signal/FPU evidence, not a relabeled C model or Linux boot claim.

## Raw register exchange, same SSA vocabulary

All24 D9/DD/DF FXCH register encodings consume one law/SSA. Both old payloads
and tags are captured before either destination write. If invalid is masked,
each empty source becomes indefinite, then the exchange occurs. Unmasked
stack invalid publishes no payload/tag swap but retains its exact exception
status/FOP/IP. C1 clears; TOP, DP and RFLAGS are unchanged.

Self exchange is an identity on nonempty data: it reads/writes no payload.
An empty self exchange has a constant indefinite result, so its latent bytes
are also not read. Empty lanes and unmasked suppressed exchanges do not incur
unneeded operand loads. This is typed construction and ordinary emitted Wasm,
not an x87 decoder/interpreter inside the VM. Intel's
[masked exchange rule](https://www.intel.com/content/dam/support/us/en/documents/processors/pentium4/sb/25366521.pdf)
describes replacing empty operands before exchange; the actual states below
independently exercise the boundary.

Measured pure upper bounds are raw load30/span11 and exchange12/span3. These
are family upper bounds, not global minima, physical CPU instruction counts
or a Linux speed improvement.

## Verification and retained paths

- **8,448** complete physical Windows FPU/RFLAGS/full-tag states,132 mask/
  occupancy profiles through33 actual C-generated modules, pass C-MMU/table
  execution. Other-GPR invariance is architectural, not a bare-metal certificate.
- **264** prefix/form constructors and **3,696** malformed-law controls pass.
- Raw80 access models:180 #NM/#MF/absent/split faults and12 full-state pushes.
- All FXCH forms/prefixes, direct+C-table, MP/TS/EM/NE and pending/masked states:
  **18,432** complete models (13,824 #NM,768 #MF,768 FERR,3,072 successes).
- Retained physical IEEE loads6,144 and FILD12,288 pass the common publisher.
  Physical packed XMM47,520 rows pass the widened memory owner.
- The complete existing vector population has464 native/cold byte-parity
  forms,59,392 direct+59,392 dispatch comparisons,78,272 independent native
  fault comparisons,856 retry models and13 pair-entry refusals. Valid shorter
  pair reads are no longer asserted to be invalid by the old rejection test.
- VM/scoped compiler/postlink and positive ASan/UBSan checks pass without
  warnings; postlink semantic completeness464 witnesses remains green.

The earlier unrestricted intermittent CALL RAM-payload equivalence red remains
[separate](2026-10-05-call-fault-windows.md). A missing older vector fixture
directory was not mistaken for a product fault; the complete region population
was used for the final regression above.

Compiler703,549 bytes, SHA256
`a32f7c938e42aa8993647462318b3f935900ea23c45205d539bbcd4e4413b4c5`.
VM99,070 bytes, SHA256
`61b9d2a49e38038105bf7cf0555346ff146be82a22bedf707918e539e5db11ea`.
These are fresh paired ABI4 source products, not a rewritten signed release.
Same-bundle short startup preserves the86-cut witness/1,617,931 source
retirements/quota; none proves actual PID1/offline shell/cold-ready/RSS.

```sh
make -C src/v2/x86 all
make -C src/v2/vm all check
make -C src/v2/wasm-compiler all x87-load-view-check x87-load-fault-check
PHYSICAL-OBSERVER NEW-ROWS
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-ROWS --load-view
node data/oracle/check-x87-fault.mjs VM.WASM COMPILER.WASM --raw-load
node data/oracle/check-x87-wait.mjs VM.WASM COMPILER.WASM --exchange
bash src/v2/wasm-compiler/check/sanitizers.sh
```

Continue remaining SIMD, floating state/conversion and far-control families
to ZERO and the actual browser Linux objective, not a smaller fixture target.
