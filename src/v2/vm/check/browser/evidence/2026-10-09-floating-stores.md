# Floating and integer stores share one publisher — 2026-10-09

The same published make's all-PF_X-byte domain improves **732 ->625 missing**:
all **107** previously missing FST/FSTP coordinates are now closed. Lowerable
232,830 of233,455; unlowered fault/fetch/capacity counts remain zero. This is
not whole-bundle closure, a new signed Linux release or browser shell evidence.
Native bundle and human UI are unchanged.

## One lowering, no numeric VM interpreter

`lower-x87-integer-store.c` is moved to `lower-x87-store.c`. Integer conversion
and binary32/64/extended stores supply different pure SSA payloads to the SAME
checked memory publisher, status/FOP/DP publisher, tag update and conditional
pop. The old lowering is not retained as another product source population.
`CUT_SYSTEM_X87_STORE` names its actual responsibility. No host f64 conversion,
SoftFloat library, guest opcode callback or JS/Python execution is in the
product. Official SoftFloat is a numeric reference only.

Memory publication is write-only preflight followed by exact payload words.
Extended80 uses eight bytes then two inside the existing C-owned reservation.
It does not load/RMW the destination, copy a CPU state or materialize a lane
array. Register destinations use the same source outcome and publisher;
payload/tag writes precede the conditional pop. Precise faults or residency
waits cannot publish those CPU effects early.

The checked frontend covers binary32/64 FST/FSTP, memory80 FSTP, DD and DF
register encodings and D9 FSTPNCE. FOP derives from the decoder's actual opcode
and ModR/M, not the first two source bytes (which can be prefixes). Exact
width/pop/destination/effect/extent checks preserve malformed-output sentinels.

## Exact rounding and exception boundary

For significand M, effective extended exponent E, target fraction bits F and
target bias B, first substitute the target scale:

```text
E = max(stored_extended_exponent, 1)
target_minimum_normal_E = 16384 - B
d = 63 - F + max(0, target_minimum_normal_E - E)
q = round_RC(M / 2^d)
```

The actual plan makes every shift total, including d>=64, retains exact
residue/half/tie/odd predicates, carries a rounded significand into the target
exponent and preserves NaN payload/sign or emits the defined indefinite.
PC does not round a store format. No loop, floating approximation or double
rounding is used. The pure numeric graph's measured maximum is work117/span34;
this is an upper bound, **not** a global optimum or a speed claim.

Tiny detection is after rounding: a value just below minimum normal that rounds
to normal has no UE. Unmasked UE also detects an exact tiny result. Invalid,
unmasked format overflow and unmasked underflow suppress memory and pop;
unmasked precision still stores/pops while latching the deferred exception.
Unmasked overflow/underflow suppress precision/C1 publication. Source denormal
does not itself raise DE on a store. Extended80/register copies preserve raw
SNaNs and unsupported encodings; stack emptiness still has its separate law.
These distinctions agree with Intel's [floating exception contract](https://www.intel.com/content/dam/develop/external/us/en/documents-tps/253665-sdm-vol-11.pdf)
and [store instruction description](https://cdrdv2-public.intel.com/774492/325383-sdm-vol-2abcd.pdf),
and with the independent observations below.

The general postlink completeness test found D9 D8/FSTPNCE in addition to the
DD/DF stores. Its observed distinction is now explicit: when ST(0) is empty,
no source payload is read, no transfer or new stack fault occurs, but TOP pops.
An empty-source destination retains its old payload/tag. Nonempty source
copies normally. The same pending-exception guard and publisher implement it;
there is no second VM execution path. All464 semantic completeness witnesses
are green after this correction, not deleted or weakened.

## Independent results and refusal models

- **16,640** physical Windows FPU/RFLAGS/full-tag/memory rows across260
  memory/register/RC/mask profiles match actual final C compiler/C-MMU/table
  execution through45 distinct modules. Other GPR invariance is architectural.
- **600,000** official SoftFloat3e canonical binary32/64 payload and exception
  comparisons pass. This excludes empty/unsupported sources and unmasked
  suppression, whose native/C-boundary populations are separate.
- **60** independent reference-build-VM signal/FPU/memory rows pass:13 actual
  protected-page #PF/error7,17 readonly nonfaults, invalid/precision/overflow/
  underflow suppression/order. The actual C/Wasm path matches all60 through
  five generated modules, including the untouched padding after80-bit stores.
- **9,600** direct+C-table boundary models pass:8,784 #NM/#MF/protected/split/
  noncanonical faults and816 suppressed stores. Full CPU/data remains
  unchanged on a fault; a suppressed instruction retires once without any
  destination access or pop.
- **360** prefix/form constructors and **5,040** malformed-law controls pass.
  Retained integer-store24,576 physical rows still pass after consolidation.
  VM, scoped compiler/postlink checks and positive ASan/UBSan are warning-free.

The unrestricted repeated native CALL RAM-payload equivalence issue remains
[separately documented](2026-10-05-call-fault-windows.md); these scoped greens
do not declare that unrelated architectural obligation solved.

## Native pointer observation constraint

An initially high-address Windows observer population has two retained
truncated-FIP/FDP rows. Windows' [XSAVE_FORMAT fields](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/Diagnostics/Debug/struct.XSAVE_FORMAT.html)
include32-bit ErrorOffset/DataOffset. The existing arithmetic oracle already
constrains code/data to representable addresses across OS context switches.
That allocator is now a shared test helper, and the complete final population
uses it. No individual row was repaired or product semantics changed to fit
those high-address observations. This is a supported observation domain, not
a proof of the exact OS/Hyper-V cause or universal bare-metal FIP behavior.

## Products and reproduction

Final compiler694,187 bytes, SHA256
`2910a4b3b9cf18d69bf4ad008d036c5e7f62b00f838edeeefd42d028a5c7145d`.
The paired ABI4 VM is unchanged98,252 bytes, SHA256
`aba9295efb733abb1e740da272a1128905c3d070139220f22fc20070b8f843ee`.
The growth adds the exact compiler-side numeric law; it is not called a
distribution compression/speed improvement. Same-bundle startup keeps the
86-cut witness/1,617,931 source retirements/quota, not PID1 or cold shell.

```sh
make -C src/v2/x86 all
make -C src/v2/wasm-compiler all x87-float-store-check x87-float-fault-check
PHYSICAL-OBSERVER NEW-ROWS
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-ROWS --float-store
NATIVE-FAULT-OBSERVER NEW-FAULT-ROWS --float
node data/oracle/check-x87-state.mjs VM.WASM COMPILER.WASM NEW-FAULT-ROWS --float-fault
node data/oracle/check-x87-store-boundary.mjs VM.WASM COMPILER.WASM
bash src/v2/wasm-compiler/check/sanitizers.sh
```

The numeric reference compiles `x86/check/x87-float-store.c` with product
`x87-float-store.c`, compact/sweep/arena and the pinned test-only SoftFloat3e
library (`SOFTFLOAT_FAST_INT64`, `LITTLEENDIAN`). Next close the remaining
load/register-view, SIMD and far-transfer families without relaxing the full
publication/actual-browser objective.
