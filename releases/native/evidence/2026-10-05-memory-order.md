# Empty ordered-access frontier — 2026-10-05

The completed permutation compiler stops at the actual shipped kernel's
`0f ae e8` (LFENCE), `0xffffffff810332c7`, after 165,880,678 retirements.
That is an independent Node startup, not browser/PID 1 acceptance.

## Derivation before lowering

Intel SDM revision 093, Vol. 2A 3-552 and Vol. 2B 4-15/4-628 specify
LFENCE, MFENCE and SFENCE separately. Their constraints concern preceding
instruction/load/store completion and the ordering of subsequent accesses;
they do not modify GPRs, arithmetic flags or FPU payload. LFENCE/MFENCE require
the SSE2 CPUID bit; SFENCE requires SSE. LOCK is invalid. EM/TS/OSFXSR are not
additional fence exception predicates. The fixed CPU profile supplies those
capability bits; this change neither discovers host capabilities nor widens
that profile. The low three ModR/M bits are ignored by all three instructions.
See [Intel's instruction reference](https://cdrdv2-public.intel.com/782156/325383-sdm-vol-2abcd.pdf).

For an admitted synchronous, single-owner ordinary-Memory projection, let
`C_i` denote completion of an access and `B_i` the next access's beginning.
The C access transaction returns only after completion/publication, and the
serialized dispatcher cannot begin its next cut before that return. Hence,
for every access before and after the fence respectively,

```
C_before <= begin(fence) <= end(fence) <= B_after
pending_loads(fence) = pending_stores(fence) = 0
value_action(fence, state) = state
```

All three required ordering relations are already subsets of this stronger
serialized relation. Substituting the empty frontier therefore removes the
fence's value-state payload, not its instruction boundary. The generated
cut still checks its state reservation, debug/TF and exact RIP, then advances
RIP/retirement and clears RF on success. A previous fault/wait cannot retire
the fence, and both fetch pages of a crossing fence must first be admitted.

There is no opcode callback, pending-access image, full-state copy, C/JS
interpreter or host atomic-fence import. This does **not** equate a guest
LFENCE with a host speculative-side-channel mitigation. Shared RAM, multiple
vCPUs or asynchronous accesses invalidate the empty-frontier premise and
require a replacement ordering lowering. Ordinary generated memory imports
reject a shared Memory at link time; concurrent memory is not silently accepted.
See the [ordinary/shared memory distinction](https://webassembly.github.io/threads/core/exec/runtime.html).

## Red, unchanged native observations, green

Before implementation, the general C compiler returns grammar `-102` for the
canonical LFENCE. Independent build-VM native x86 records first captured
7,680 GPR/flags/FPU observations: three instructions, all eight ignored
ModR/M ranks, five entrance prefixes (none, address-size, REX, FS, GS),
64 seeded inputs. The fixture measures complete GPRs and the native FPU
envelope; other owner fields are preserved, and successful RIP/retirement
are derived from the known one-instruction boundary. This is not a native
SMP litmus test, nor a privileged EM/TS/OSFXSR hardware oracle. Provenance is
the independent WHPX build guest, not assumed bare metal.

An exploratory `66`-prefix input terminated with native SIGILL (not a captured
architectural-vector receipt). It is not in the accepted
population. The compiler explicitly refuses that input along with LOCK,
reused F3 opcodes, SERIALIZE, INVD/WBINVD and memory cache-management forms.
No native records or strict CALL expectations were changed to obtain green.

The final general lowering passes:

* 120 exact native-C/cold-C emissions; the pre-lowering 7,680 native records
  are byte-identical.
* 30,720 direct/C-dispatch full-state comparisons, including RF, plus 7,680
  separately labelled CPL/EM/TS/OSFXSR/AC context models.
* 840 unchanged entry refusals and 120 shared-Memory link refusals.
* 600 actual C instruction-fetch/generation/wait/retry checks, 384 real
  C-MMU store/fence/load and prior-store-fault checks, 12 crossing-fetch
  frontier checks and six ordinary-memory growth checks.
* Full C compiler/CLI `check all`, scoped compiler ASan/UBSan, the existing
  384 vector, 108 scalar and 16 MXCSR exact emissions/comparisons, borrowed
  source/overlap/grow and bounded engine-owner regressions.

A matched one-million-admission prefix with independent segment input retains
47 non-size/non-clock/non-timing top-level observations, including 1,616,430
retirements, 1,211 engine constructions and 460 evictions. Only UTC/clock
sampling, time and compiler length differ. This unchanged prefix does not
exercise the later LFENCE and is not a performance benchmark.

Each emitted fence cut is 205 bytes. Its only import is ordinary
`machine.memory`, with no guest access or ordering function. This is a value
payload elimination under a proved execution contract, not a global optimality
or startup-speed claim. See comparison receipt
and original red.

Reproduce with fresh directories:

```sh
make -C src/v2/wasm-compiler build/memory-order-check
mkdir temp/fresh-fence-observe temp/fresh-fence-emitted
src/v2/wasm-compiler/build/memory-order-check temp/fresh-fence-observe --observe
src/v2/wasm-compiler/build/memory-order-check temp/fresh-fence-emitted
node data/oracle/check-memory-order.mjs VM.WASM COMPILER.WASM temp/fresh-fence-emitted temp/fresh-fence-observe
```

VM remains 63,052 bytes, SHA-256
`a0bb464e8f4d3bd47e9dbc12fe84ac111cb9e9ad9a52d190be67a3f615cb814c`.
The final compiler is 446,566 bytes, SHA-256
`f5b8e31bfe9649d9f5eae79c4b0cd2a88c1065fb216e891acabd590f2a0ebeb5`.
Its same-bundle extended startup is in progress, with unchanged engine
quotas and independent segment/decompression/root-image inputs. No completed
startup result or speedup is inferred from these fixtures. The preceding
18,346,806 engine constructions remain the measured dominant cost.

Native release bytes and human UI are unchanged. PID 1, immutable release-root
mount, shell/development commands, storage/recovery, granted networking and
real-browser acceptance remain open; the cold shell 3s target is unmet.
