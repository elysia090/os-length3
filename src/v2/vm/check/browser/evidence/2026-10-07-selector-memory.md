# Segment-selector memory frontier — 2026-10-07

The exact published `make` has a missing `8e 03` coordinate at `0xa0c5`:
MOV ES,[RBX]. The previous native emitter and frozen cold compiler both refuse
the corresponding general memory-source MOV with -102. Register-source loads
already use the C segment owner; a second segment implementation is unnecessary.

## Ordered transfer

[Intel's MOV reference](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developers-manual.pdf)
defines source memory faults, selector/descriptor checks and SS interrupt
inhibition. The shared decoded law is now explicit for MOV ES/SS/DS/FS/GS:

```text
selector = read16(EA(old registers, old source-segment context))
next_cache = descriptor_admit(target rank, selector, old CPL/GDT/LDT)
publish selector + next_cache + the existing SS-shadow transition
retire one source instruction
```

A source fault/wait returns before descriptor admission. A descriptor fault /
wait returns before destination or retirement publication. Paging A/D and a
successful descriptor Accessed update remain ordinary guest RAM effects.
MOV has no CPL0 gate. Privileged LLDT/LTR retains privilege-before-source.
The common `pl_x86_segment_move_supported` law feeds native SSA and the
independent Wasm backend. It emits the existing C `machine.access` then
`machine.segment`, with the same attested displacement. No opcode/source
register number/EA decoder is added to the VM. ABI, VM bytes, owner quotas,
published native bundle and human UI are unchanged.

LFS/LGS/LSS also carry the write-segment machine tag, but are NOT this MOV law.
Full native checks exposed that distinction. Their old far-pointer semantics
are preserved; this does not close their independent Wasm grammar.

## Independent red and green

[Candidate receipt](2026-10-07-segment-load-green.json) separates observations
from models. Native x86 in the reference build VM gives 300 successes / 450
faults over all five target ranks, 32/64-bit addresses, ignored 66/REX.W
prefixes, base/index/stack/RIP-relative/extended-register shapes, null/valid/bad
selectors and unreadable/cross-page/noncanonical sources. Invalid selector
data behind a failing source proves the source fault wins. Full GPRs, flags,
visible selectors, trap/error and source-fault addresses are retained.
Native fault frames add RF; that bit is distinct from unchanged instruction
arithmetic flags. The TLS-restoration envelope does NOT independently observe
the loaded hidden FS/GS base.

Cold C matches 750 native-C emitted modules byte-for-byte. Actual C-Wasm
MMU/function-table execution matches all 750 native rows. Another 810 separate
models cover hidden cache / SS shadow, nonpresent/invalid descriptors,
Accessed writes, readonly GDT priority and absent descriptor residency. There
are 750 old-generation refusals. Failed reads/admission leave complete CPU and
hidden cache unchanged. 9,750 malformed descriptors are refused by the shared
native/frontend law before arena allocation.

```text
make -C src/v2/wasm-compiler segment-load-check
make -C src/v2/wasm-compiler segment-sanitizer-check
src/v2/wasm-compiler/build/segment-load-check NEW-NATIVE-FIXTURE-DIRECTORY
node data/oracle/check-segment-load.mjs VM.WASM COMPILER.WASM NATIVE-FIXTURES
```

Fixture output is no-clobber. ASan/UBSan uses separate temporary product builds,
cleaning only that fresh directory. Full x86, Wasm-compiler and postlink checks
pass, including 464 semantic completeness witnesses. The broad tag guard was
red on six far-pointer witnesses and is corrected. Source/cohort, count/fault,
register-update and 28-function mixed-module regressions pass.

```text
compiler.wasm 457,861 bytes
eb717529a33996949311470b6d2314514a3b25b0f674409f1fc9943aee4ac325
unchanged vm.wasm 81,547 bytes
0a8ee799638de906a4d87e4496e7be25ee4e46241882bc5de71b6dc8d34777b4
```

## Exact coverage, not execution frequencies

Every final PF_X byte of the exact published inputs is inventoried. `make`
unlowered coordinates fall 7,329 -> 7,251 (78); s6-ftrigrd 1,580 -> 1,560 (20);
s6-rc-init 1,768 -> 1,752 (16). The first make miss is closed; the next is
`df e8`, an x87-family witness. Hashes/full reports are in the receipt.
Interior bytes/padding are included: NOT hot instruction frequencies, Linux
speed/size reduction or complete executable closure. Whole ELF remains -104.
This candidate is NOT loaded into the long browser run.

## Actual browser crash, not completed startup

[Last visible snapshot / terminal tab observation](2026-10-07-browser-crash.json)
retain separate `f719212` binaries and the unchanged published bundle.
The actual browser reached 236,680,689 retired / 129,048,368 admissions,
logged `/init` startup and `crng init done`, then tab metadata changed to
`This page crashed`. No final compiler/fault/quota result or usable shell is
observed. The Worker is no longer confirmed live. This is terminal failure,
not observation timeout; do not resume from a guessed state.

The last snapshot has 11,747,890 constructions / 11,747,145 evictions despite
262,093 encoded witness bytes retained. Cold/engine are 519,630 / 603,764 ms
of 1,654,903 ms elapsed. NOT completed timings or paired speedup. Crash cause
and native-code/RSS high-water are unproved; do not label it OOM. Encoded-byte
quotas and WeakMap/LRU eviction alone cannot prove native/OS reclamation.

The dominant connection remains complete C-produced module/coordinate
projection -> authenticated C Artifact lookup/residency, eliminating
reconstruction before compiled-body lookup. Exact machine/device/dirty-cut
recovery is also required for Worker recycling. Raising quotas, rerunning a
long prefix unchanged, treating observed RIPs as closure or relaxing the
sandbox does not establish these obligations. PID 1/offline terminal,
development/storage/network and cold shell three seconds remain red.
