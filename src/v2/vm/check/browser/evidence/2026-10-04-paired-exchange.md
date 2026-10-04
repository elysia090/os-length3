# Paired memory compare/exchange — 2026-10-04

The same shipped bundle passes the previous CMPXCHG16B entrance at
`0xffffffff8111de16` in the actual browser Worker. Next is compiler -102 at
`0xffffffff81050643`, bytes `48 0f c1 05 a5 45 9e 00`: memory XADD.
PID 1, shell and the full browser goal remain unachieved. Diagnostic `pass`
means its assertions passed, not that Linux boot passed.

## One reservation; compiled comparison

For CMPXCHG8B, split the reserved u64 into low/high u32. For CMPXCHG16B,
reserve low/high u64 together. Let `e = (a == old.low) & (d == old.high)`.
The compiled SSA chooses `(e ? b : old.low, e ? c : old.high)` for memory.
After the single successful commit, mismatch replaces the accumulator pair;
match preserves both whole parent registers, including the upper halves of
RAX/RDX in the 8B form. ZF is e; CF/PF/AF/SF/OF retain their incoming values.
No opcode/compare loop enters the VM callback boundary.

The [Intel instruction reference](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf)
(CMPXCHG8B/CMPXCHG16B, volume 2A, pages 3-210 through 3-212) requires a
memory write on both comparison arms and 16-byte alignment for the wide form.
Therefore readable-but-not-writable memory cannot become a successful
mismatch. The C MMU validates the complete range with write intent before
filling either private value word. Misalignment is #GP before a page walk;
canonicality retains #SS for stack operands. Architectural A/D updates on
walked predecessors remain observable, as for every existing precise access.

The existing bounded private record reservation/commit is reused, not two
independently visible scalar transactions. The 56-byte pair port extends the
48-byte scalar port with a separate high word; it does not overwrite fault or
request fields. C bounds checks keep the entire port disjoint from CPU/segment
state. Commit consumes the entire reservation once, including stale/invalid
attempts. Wrong width/port, cancellation, another access and close cannot
reuse it. Guest RAM cannot expose the private sixteen-byte C stack buffer.

LOCK and implicit atomicity use the existing pinned, synchronous single-vCPU
owner: no competing guest writer, event, remap, eviction or await may intervene.
This is not an SMP, SharedArrayBuffer or inter-Worker atomicity claim. TF/AC,
active debug breakpoints and unowned FS/GS address bases remain explicit
refusals. Debug exception delivery remains a separate incomplete boundary.

## Independent comparisons

- Initial red: existing compiler refused pair form 0 with -102; an independent
  `--observe` run executed all 72 x86 forms before the implementation.
- 72 widths/LOCK/address-size/base/SIB/RIP-relative forms; 18,432 native CPU/RAM
  observations, 4,096 alignment faults and 14,336 native protection faults.
  Both equal and unequal operands, parent-register preservation, noncontiguous
  split 8B accesses and aliased RAX/RDX/RBX/RCX bases are exercised.
- Every generated module matches the independent cold C-Wasm emitter exactly,
  through both raw-page and optimized-ELF admission (72 + 72 comparisons).
  Actual C vm.wasm: 18,432 CPU/RAM comparisons, 18,432 protection/alignment
  comparisons, 56,192 additional dispatcher comparisons, 36,864 RF checks,
  896 waits/retries, 576 refusals and 216 reservation revocation checks.
- 72 ordinary linked ELF -> independent postlink compiler -> accepted optimized
  ELF + proof fixtures pass postlink-verify and emit the same Wasm as raw pages.
  This does not claim a new native instruction-count reduction: these barriers
  remain explicit source instructions in the native projection.
- Pure prefixes retire separately. Refused FS/GS/register forms and short
  output buffers leave source, output, byte count and report untouched.
- Native product checks and selected C MMU/record/compiler ASan+UBSan checks
  pass. General record tests additionally preflight a failing second page and
  consume successful two-fragment commits once.

The native oracle is real x86 execution in the QEMU TCG reference build VM,
not physical hardware and not a product guest-execution fallback. Exception
entry RF is distinguished from the unchanged pending-fault CPU flags.

Reproduce without WSL:

```sh
make -C src/v2 check
bash data/oracle/prepare-paired-exchange-cuts.sh temp/new-paired-elf
node data/oracle/check-paired-exchange.mjs VM.wasm COMPILER.wasm temp/new-paired-elf/accepted temp/new-paired-elf/elf
```

## Actual browser receipt

[Browser JSON](2026-10-04-paired-exchange-browser.json) records 137,071,982
retirements / 69,316,535 admissions, no manual branch entries, unchanged exact
14,622,864-byte decompression proof and an observed Linux ELF entry. Six #PF
and ten #GP deliveries reach guest handlers. There are fourteen virtual clock
events. PID 1 and an interactive shell were not reached.

Transport: 49 fetches, 3,154,432 fetched / 3,046,912 requested bytes, 65,536-byte
cache high-water. VM memory 18,874,368 bytes; compiler memory 1,048,576 bytes;
4,425 resident / 4,412 supplied pages. Source cache: 67,999,471 hits / 1,317,065
misses, 64 rows / 6,752 metadata bytes / zero retained source payload copies.
Engine cache: 1,317,064 compilations / zero hits, 64 retained modules / 23,146
retained bytes. 459,619,527 emitted and 5,395,329,024 copied code bytes are
cumulative work, not simultaneous memory or the native download's size.

Diagnostic timing: cold 19,075.9 ms, engine 110,746.8 ms, execution 36,610.0 ms,
admission 22,808.8 ms, supply 274.3 ms. This concurrent validation run is not a
controlled benchmark, a speedup claim or a cold-shell measurement. The
three-second shell objective is still unmet; zero engine reuse remains an
explicit fixed-cost task after correctness closure.

VM: 41,774 bytes, SHA-256
`15116f16e3eb04bcb1d08444c85e54d79ed94e3413f8a59c1402048de24df957`.
Compiler: 430,295 bytes, SHA-256
`e3b114f8fda3c312cbf74bcea3ee8931470234785060c3ecbc4fdaa0e2efdea8`.
Native bundle/root/optimized ELF and human UI are unchanged. Local diagnostic
object digests are not a newly signed production admission claim.

Next: join memory XADD/XCHG to the shared arithmetic/transaction SSA. Keep
source/address aliases and precise faults observable, never interpret a
missing operation in JavaScript or C as a workaround.
