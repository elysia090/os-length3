# Selected-half transfer through the exact memory boundary — 2026-10-06

## Completed Linux gate, not a boot claim

The unchanged-bundle `f1ab0fe` Node run completed. General LOCK RMW passes;
the next cold compiler refusal is -102 at `0x7ff37faf2051`:

```asm
0f 16 05 88 b8 00 00    movhps xmm0, qword ptr [rip + 0xb888]
```

It retires 189,152,720 source instructions / 99,217,996 admissions. Engine
construction is 321,690 ms, cold emission 273,294 ms, execution 80,363 ms,
extent supply 1,129 ms, total 842,132 ms. The engine owner constructs
7,445,051 instances and evicts 7,444,310; 741 exact witnesses occupy 262,093
bytes under unchanged quotas. Different work and active-execution clock
calibration are not a paired speedup. The `/init` announcement is not
successful PID 1, a mounted release root or an offline shell. See the
[unchanged completed receipt](2026-10-06-node-startup-movhps-red.json).

## Derive the live half before choosing a physical access

The [Intel instruction reference](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf),
Vol. 2A MOVLPS/MOVLPD/MOVHPS/MOVHPD, specifies an eight-byte memory operand
and preservation of the other legacy XMM half. No floating-point conversion,
rounding or arithmetic occurs. For h in {0,1}, XMM=(V0,V1), exact operand
M=load64(A), substitution is simply:

```text
load:  Vh' = M;       V(1-h)' = V(1-h)
store: memory64(A)' = Vh;     XMM' = XMM
```

The second load assignment is an identity and disappears. With one resident
architectural owner, the retained half already has its final physical value:
do not load it, blend/reconstruct a full vector, or store it again. Eight
observable operand bytes still require complete C preflight; removing the
identity is not permission to skip rights, residency or a fault frontier.
For a store, capture the selected half before that exact access. For a load,
publish one selected-half store only after access succeeds. There is no
sixteen-byte temporary, read_pair import, extra VM opcode callback or ABI
field. This is a local exact substitution, not a universal minimum proof.

The common decoder already provides descriptor kind 14, direction, vector
rank and h. The scalar-width entrance formerly rejected it. It now validates
those typed fields and admits only a 64-bit memory operand and a valid XMM
counterpart. MOVD/MOVQ keep their separate specified upper-zero behavior;
their upper store is not deleted by this rule. The shared SSE guard retains
#UD/#NM priority before operand access. Existing AC/TF refusals, private port,
RF retirement, FS/GS normalization and single-owner restrictions remain.
VEX, MMIO, SMP and debug/alignment closure are not claimed.

## Independent red and green

Before changing lowering, observe-only native x86 execution saved 9,984
complete CPU/RAM observations, including 3,072 rows for the 48 new half forms.
The normal fixture stopped at form 108 with compiler -102. After lowering,
all records remain byte-identical; the old frozen compiler still fails the
strict cold comparison at the first new form. No expected result was relaxed.

The four new families have load/store forms and six address topologies:
32-bit truncation, RSP, scaled R12, RIP-relative, negative disp8 and disp32.
Inputs cover unaligned operands, all eight page-end geometries, noncanonical
addresses, read-only/unmapped pages, raw bit patterns and unrelated-state
preservation. Native x86 runs in the independent reference build VM, not a
physical-hardware claim. Native observations include 656 new fault frames
(1,148 over the full scalar suite).

The [green receipt](2026-10-06-selected-half-green.json) records:

- 156 fresh native-C/cold-C byte-identical emissions, 9,984 direct and 9,984
  C-dispatch CPU/RAM comparisons; 19,968 RF models and 4,592 fault comparisons
  (the same 1,148 independent frames in four executions, not four oracles).
- 128 separate exact-extent models: eight bytes ending at a present page
  succeed with the next page absent; each of the seven crossing splits
  faults without publishing any CPU/payload change. Widening to sixteen
  bytes cannot pass the first case.
- 260 typed descriptor refusals. The h bit is deliberately not malformed:
  changing it selects the other valid half; native rows check both choices.
- 2,184 control-priority models, 280 direct/dispatch physical wait/retries,
  2,040 private-entry/context refusals and existing XMM-only alias regressions.
- 41-family FS/GS address substitution models: 492 comparisons and 328
  actual C latched supply resumes/retries. The four new families contribute
  48 comparisons / 32 resumes. These isolate addressing, not independent ISA
  semantics or a browser result.
- Full native `make check`, including CLI, and scoped GCC ASan/UBSan scalar
  and code-cut checks pass. Provider libraries are not sanitizer-instrumented.
  Two invocations initially named nonexistent phony targets; actual `check`
  and the explicit code-cut binary were rerun successfully.

VM is unchanged at 70,499 bytes, SHA-256
`0c3142f523b4713e5034772569a73f32d6abe71f73c23d6da9bc45319c7e950f`.
Compiler is 453,522 bytes (+272 from the immediate-bit candidate), SHA-256
`53f774bce965b1878cc91ea01b7ebb991a6482796d41f910282ce16430a64439`.
No native release-size reduction or boot speedup is inferred from this gate.

A separate frozen same-bundle run started at 2026-10-06 11:30:28 JST,
PID 7804, `temp/half-vector-1006/frozen`, warmCuts=64, unchanged quotas.
It includes the immediate LOCK-bit extension and this half transfer, not
later edits. Obtain its completed next gate before claiming Linux passage.
Retained browser Workers/staged assets, published native bundle and human UI
are untouched. Browser acceptance, PID 1/root mount/shell/tooling and cold
shell 3s remain unachieved.
