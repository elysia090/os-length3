# Compiled-source metadata connected to C admission — 2026-10-07

## The missing connection

The C Artifact reader authenticated an ordinary Wasm object, but source/span/
binding still came from a new compiler invocation or host-supplied fixture
values. A 64-row source eviction could not rediscover the already compiled
transfer through that reader. Frozen old VM is independently red: no
`vm_directory_module_plan` export exists.

## One derived projection, one executable prefix

The independent C compiler now emits an ordinary bounded Wasm collection with
a trailing `machine.source` custom section. [The Wasm specification](https://webassembly.github.io/spec/core/binary/modules.html#custom-section)
defines such sections as non-executable metadata. Rejecting this descriptor
is a source-admission refusal, not a claim the underlying module is invalid.

The section carries ABI markers/generation, one or two exact source pages and
sorted 16-byte source rows: offset, span, instruction count, admitted limit,
scalar binding. Export ordinal is the row rank, not a saved second column.
The prefix is byte-identical to the existing ordinary code collection. Metadata
therefore does not split executable-body identity or add an opcode stream.

The existing C Artifact path authenticates the COMPLETE immutable object.
The same VM then parses its bounded descriptor, chooses the entry/ordinal in C,
compares only that span against current C-MMU borrowed source bytes and returns
a 16-byte prefix/ordinal DTO. The host consumes that exact authenticated prefix
and installs the selected typed export. C publishes span/count/binding from
the descriptor, not JavaScript. No x86/Wasm instruction interpreter, host
canonical-row parser or metadata-less execution fallback is introduced.

For this role, the existing resource coordinate identifies source witness page
0 or 1. A verified crossing descriptor can demand TAIL; C then admits the next
executable page before publication. Source writes cancel pending leases BEFORE
mutation, including changed-back bytes. Descriptor/source/ABI/budget absence,
wrong generation/ticket and cancellation cannot publish old code. The caller
pins the immutable private object buffer through engine consumption/publication;
buffer reuse or replacement requires directory cancellation/query/rebind.

Authentication alone is NOT compiler equivalence or root authorization. A
trusted selected compiler root must bind the actual CPU/load/code profile;
engine type/table identity remain supervisor obligations. The new object is
derived DELIVERY metadata, not another canonical machine or CLI executable
format. Its source witness must share/rederive the canonical source byte owner
under Artifact/Storage before real release packing. Do not persist a second
native source population or claim a distribution-size improvement here.

## Actual red and green

[Receipt](2026-10-07-source-module-green.json): 130 native x86 GPR/full-flags
rows and a C-produced module; cold C reproduces its exact bytes. Six rounds
over 130 coordinates genuinely evict the unchanged 64-row owner: 780 cold
queries, 780 complete CPU comparisons, ZERO compiler calls during reuse and
ONE executable-prefix construction. The original local index uses three C
node reads and one object read. Two-page projection separately matches cold C;
three additional C-MMU/table cases cover both witness pages and a crossing
instruction. Total two code constructions include that separate module.

Another eight controls refuse stale generations/replies, changed-back writes,
actual source mismatch, absent coordinates, stronger saturated budgets and
cancelled publication. Native parser checks every 30,614-byte truncation and
12 corrupt descriptors without changing outputs. Whole-object/output capacity
is preflighted; the source witness is not copied into a separate VM arena.

```text
make -C src/v2/wasm-compiler source-module-check
make -C src/v2/wasm-compiler segment-sanitizer-check
src/v2/wasm-compiler/build/source-module-check NEW-DIRECTORY
node data/oracle/check-source-module.mjs VM.WASM COMPILER.WASM FIXTURE CROSS-FIXTURE
```

Native VM/compiler/machine-ABI checks and scoped ASan/UBSan pass. One full run
stopped on a pre-existing native CALL target/stack-store observation; unchanged
direct CALL and the complete rerun pass. No CALL test/semantics is relaxed;
that intermittent oracle discrepancy is not explained or claimed fixed.
Source/cohort, fault and 750 selector comparisons remain green. The same-bundle
short Node prefix retains the complete 86-instruction checkpoint and 1,617,931
retirements, then quota. It does NOT use this directory for Linux delivery.

```text
compiler.wasm 459,002 bytes
a20506343c838f0084e6c8ed5c7e3398dfd2d2c143430489c9d3b706c9265259
vm.wasm 86,193 bytes
74f3a63a19030b6f931c3a0f61c3a03ae40e5ca67001d5fba4c24b73d78658d9
```

## Not the completed Linux projection

The selected 130-entry domain is a reusable C protocol test, NOT observed RIPs
standing in for whole-image closure. Module bodies are not yet globally
quotiented inside this collection. The raw page witness is not a canonical
storage minimum. Full accepted-ELF/control/indirect/executable-generation
production remains incomplete (-104), and the Linux startup driver still uses
fresh compilation. Do not install a partial prefix root as if it were complete.

The last actual browser run remains the documented renderer crash, not a live
Worker or shell. This connection is not its crash fix, measured RSS bound or
Linux speedup. Complete production/residency, native-code lifetime measurement,
exact dirty/device/machine-cut recovery and the full development/storage/network
browser gates remain required. Native release and human UI are unchanged;
cold shell three seconds is still unachieved.
