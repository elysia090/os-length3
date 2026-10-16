# Memory unary RMW and demand-driven instruction tails — 2026-10-03

The full product goal remains active: the same published native bundle ->
independent C cold compiler -> C vm.wasm -> actual browser Linux/PID 1/offline
shell, bundled C/make/Git/apk, authenticated storage/workspace lifecycle and
granted NIC use. Neither component pass nor this bounded diagnostic is boot.
The native publication and human UI are unchanged; cold shell three seconds
remains unmet.

## Common memory unary semantics

The actual browser's former memory INC refusal is closed by common
8/16/32/64-bit INC/DEC/NEG/NOT lowering, not a kernel-address callback. The
native rejection-only test was first red on 32 acceptance assertions. Input
and flags remain local until the existing C-MMU reservation/commit succeeds.
INC/DEC preserve CF, NEG computes subtraction flags, NOT preserves flags.
RIP, flags and CPU do not publish on a failed RMW. LOCK is still a separate
unsupported atomicity contract, not an ignored prefix. No VM decoder was added.

22 ordinary post-linked ELF forms cover the sixteen width/family combinations,
RIP-relative, 32-bit addresses, SIB, SS and extended GPRs. They pass 11,264
complete CPU/RAM comparisons, 10,240 actual native protection-fault comparisons
and 21,504 RF success/fault checks. Fault cases include read-only and inaccessible
split pages; successful RF clearing is tested separately from native popfq,
which cannot establish RF. These are direct generated-cut -> C-MMU comparisons,
not a separate dispatcher or exception-entry completeness claim. Native user
observations run inside the reference build VM, not on physical hardware.

Fresh CMOV memory fixtures additionally pass 54 modules / 27,648 CPU/RAM,
27,136 actual fault and 54,784 RF comparisons. A stale earlier CMOV fixture
remains rejected; it was regenerated, not relabeled as passing. Full product
checks and selected lowering/compiler ASan/UBSan pass. Decoder/provider archives
linked into that selected compiler run are normal builds, not whole-TCB coverage.

[Intel SDM Volume 2A](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf)
specifies INC/DEC carry preservation. NEG/NOT flags and precise failed RMW are
also checked against actual native observations rather than guessed flags.

## First-instruction page tails

After that fix, the browser reaches `0xffffffff810b7fff` but supplies only the
first REX byte `48`. The decoder already supports two pages; source admission
was still single-page. This is an entrance/lifetime defect, not another ISA
interpretation route. The common compiler now returns `-105` only when its
FIRST instruction is incomplete. That request publishes no output/report.
Complete unsupported or too-long instructions still refuse with `-102`.
A complete preceding prefix commits without fetching its unfinished successor.

`vm_source_query` now reserves two 24-byte code views, with an unused tail
zeroed. A miss initially admits only the first page. Only the same trusted
compiler's FETCH demand calls `vm_source_extend`; it obtains the following VA
through the C MMU, not JS address translation. A cached crossing revalidates
both pages before exposing its row. Successful crossing publication is bounded
to one instruction / at most 15 bytes. Non-contiguous physical owners are kept
as two offsets; no source payload is cached. Known exact extents watch both
owners. While compilation is pending, any write anywhere in either pinned
page cancels publication, including changes back to the same byte.

Tail NX/non-present faults retain the unretired RIP and do not expose views or
rows. A missing physical owner is a residency wait, not a guest #PF. Remap is
a compile miss, never stale reuse. A paging A-bit write can itself alias a
pinned source page; cancellation returns stale admission, requiring re-query
at the same unretired entry. No instruction is skipped or executed during that
retry. This is serialized Worker ownership, not an SMP/async lease proof.

Native 100,000 bounded replacement/collision cases plus cross-owner, exact
write, remap, alias-bucket, same-physical-page and cancelled-pin cases pass.
All C VM core tests pass under ASan/UBSan. The actual C-Wasm driver performs
ten cold compile/install operations and covers reuse, two-page dispatch,
demand-only tails, non-contiguous owners, NX/non-present/residency on cached
tails, exact writes, whole-page pin cancellation, A-bit table aliases,
generation, grow/rebind and the private function-table-slot boundary. These
checks include C dispatcher fetch rejection, not complete Linux MMU proof.
338 native/cold C-Wasm emissions remain byte-identical.

## Reproduction

```sh
data/oracle/prepare-memory-unary-cuts.sh NEW-UNARY-DIRECTORY
node data/oracle/check-wasm-provider.mjs VM.WASM NEW-UNARY-DIRECTORY
node data/oracle/check-source-admission.mjs VM.WASM COMPILER.WASM
make -C src/v2 -j2 check
```

Build fresh VM/compiler with `data/oracle/wasm-tools.ps1`, then regenerate the
diagnostic startup inputs from the unchanged shipped bundle prefix with
`prepare-browser-startup.mjs`. Open `startup.html?budget=extended` in an actual
browser. Windows `temp/` holds raw receipts/screenshots and build products;
the bounded committed receipt is a projection of visible `#result`, not a
guest-memory restart input.

## Actual browser checkpoint

[Visible receipt](2026-10-03-memory-unary-source-tail-browser.json): secure
ordinary-memory Worker, not cross-origin isolated. `status=pass` means the
bounded diagnostic witnesses pass; `linuxBoot=not-achieved` is the product
result. The same 63,219,311-byte native archive hashes to
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

The guest executes 129,071,601 source instructions / 64,425,459 admissions,
with 64 live slots and no manually supplied branch entries. Decompressed
output matches all 14,622,864 bytes / 3,571 pages before Linux PT_LOAD moves.
Linux uses its own high virtual mappings and handles six observed #PFs plus
one #GP. No host PTE repair or changed CPU signature is inserted. Fault counts
and instruction counts are not a boot percentage or completeness proof.

The next unretired refusal is `-102` at `0xffffffff81096d52`, bytes
`4c 0f b1 4b 18`: ordinary, non-LOCK `CMPXCHG qword ptr [RBX+0x18],R9`.
RBX is `0xffffffff81a3bfa0`, RAX `0x3fffffffffffefff` and
R9 `0x3ffffffffffff000`. Close this common compare/exchange family, including
the failure arm's write-permission requirement, accumulator parent rules,
subtraction flags and precise RMW ordering. Do not add a coordinate-specific
handler. PID 1/shell, full closure and development/storage/network acceptance
remain red.

Resources remain 3,674 supplies / 3,687 resident pages; VM/cold memories
15,728,640 / 1,048,576 bytes. Source-cache metadata grows from 6,216 to 6,752
bytes for the second physical owner, still 64 rows and zero payload copies;
64,054,557 hits / 370,903 misses. Engines compile 370,902 modules with no body
hits, retaining 64 instances / 20,465 module bytes. The largest measured
buckets are engine replacement 35,646.1 ms, execution 30,825.6 ms and source
admission 20,118.8 ms, then cold construction 6,012.6 ms. These are a single
diagnostic observation, not a controlled speed comparison or cold-ready time.
130,036,620 emitted bytes and 1,519,226,880 copied code bytes are cumulative
work, not resident/delivery/artifact sizes.

Object transport remains 47 ranges / 3,056,640 fetched bytes, with a 65,536-byte
cache. That excludes diagnostic fixture/module/output-digest requests. Local
fixture SHA-256 is not signed-root/AEAD/ECC production admission. Descriptor
capacity stays 8,192 / 393,200 bytes. Fresh inputs: VM 31,653 bytes, SHA-256
`cf42f4c9d83338c534c4eec5ddff389f5d5b9cca5b8f0b318077f02839675f4e`;
compiler 417,477 bytes, SHA-256
`3d778a7fa546549aee185b35b9c0a8ccddd5fceba36afa86f76fd7438dc24ac5`.
