# Ordered descriptor transfers — 2026-10-04

The full product goal and same shipped native bundle are unchanged: real
browser Linux/PID 1/offline shell, C build/run, make -j4, Git/apk, authenticated
minimal-page workspace recovery, then granted NIC HTTPS/Git/service access.
Cold shell 3 seconds remains unmet. No native rebake, human UI change, CPU
profile expansion, interpreter, coordinate-specific skip or fallback is made.

## Red, derivation and physical continuation

The previous actual browser refused `0f 01 44 24 0e`, SGDT [RSP+0xe], at
`0xffffffff8103af89`. Forty-eight general SGDT/SIDT compiler entrances were
red before implementation. All address/operand prefixes lower through the
existing effective-address SSA and `machine.table` C boundary. No descriptor
constant or opcode callback is passed to execution. Long-mode stores contain
two limit bytes and eight base bytes, regardless of 66/REX.W; flags are
unchanged. Loads retain the existing complete-read-before-table-publication
contract. [Intel's instruction reference](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf)
specifies the operand and UMIP/privilege/fault conditions.

The prior proposed ten-byte write preflight would change the reference
observation: when the eight-byte base crosses a protected page, the preceding
two-byte limit remains in RAM. The reference
[QEMU SGDT/SIDT translation](https://gitlab.com/qemu-project/qemu/-/raw/master/target/i386/tcg/translate.c)
also performs store16, address+2, store64. This observation in the reference
TCG VM is not a proof of every physical CPU's partial-fault behavior.

The C owner therefore stores limit then base. A guest fault clears the
continuation but retains any completed payload store, with no CPU/RIP/retirement
publication. Physical absence instead retains a 104-byte next-store frontier
bound to generation, port, address, operation and relevant architectural inputs.
No whole CPU/RAM snapshot, descriptor dictionary or completed-store replay is
introduced. The caller pins the compiled instruction and serializes writers.
Existing physical write observation revokes intersecting code admission.
This is not a ten-byte atomic store or an SMP implementation.

## Verification and two extra red witnesses

[The C-Wasm receipt](2026-10-04-descriptor-transfer-native.json) records:

- 96 bare executable-page forms, byte-identical native C/cold C-Wasm emission:
  LGDT/LIDT/SGDT/SIDT, ordinary/66/REX.W, address32/64, register-indirect,
  stack, extended-SIB and RIP-relative inputs. These are boot-page fixtures,
  not an invented optimized-ELF proof.
- 16,128 actual C-MMU/C-dispatch state models: privilege/UMIP, page presence,
  read-only second page, all affected operand offsets, complete CPU/segment/
  two-page payload comparisons. The fixed profile still excludes UMIP;
  these additional UMIP inputs do not advertise or enable it.
- [108 unique actual x86 user-mode observations](2026-10-04-descriptor-transfer-observation.json)
  in the reference QEMU TCG build VM: both stores, all prefixes/address widths,
  offsets 4085/4086/4094, readable/nonpresent/read-only second page. Descriptor
  values are observed, not guessed. Native fault vector/error/CR2 and partial
  payload match C. Other privilege/UMIP states remain explicit models.
- 216 real physical supply waits/resumptions with pinned instruction/CPU and
  exact one-time retirement. A completed limit is not replayed: one witness
  makes its page read-only before base continuation. This is a deliberate
  test perturbation, not permission for production concurrent host writers.
- 2,244 refusals plus 108 ordinary-abort preservations, including unrelated
  guest API/admission attempts, stale/mismatched inputs and duplicate replies.
  Prepared page supply is preserved, not merely visible CPU state.

The native observer itself initially returned 108 rows with only 72 unique
coordinates. Its address-size-32 reference destination was a truncated stack
pointer, and an unprotected reference call jumped to an old signal frame.
That raw receipt is invalid. Complete grid validation now makes it red; every
native invocation has a current continuation and a MAP_32BIT destination.
Only the corrected receipt above is authoritative.

A second red showed unrelated `vm_access` correctly returned ENTRY_MAP yet
cancelled a prepared supply ticket before checking the table frontier. The
frontier guard now precedes cancellation in all unrelated entry points;
ordinary RMW abort cannot undo this partially committed instruction. Explicit
close/rebind still ends it. Native C checks separately cover 558 models,
including frontier input mismatch and write-observer counts.

Full `make -C src/v2 -k -j2 check`, all linked VM-core ASan/UBSan and selected
table/lowering sanitizer checks pass without warnings. Decoder/support/proof
archives in the selected compiler run remain ordinary builds; no whole-TCB
sanitizer claim. All 1,308 native/cold emissions and existing carry/division,
IO/clock, source admission and page-supply regressions pass on the new VM.
These tests do not establish complete system exception entry or Linux boot.

Reproduce in an ordinary x86 Linux test oracle with UMIP disabled:

```sh
bash data/oracle/prepare-descriptor-transfers.sh NEW-DIRECTORY
node data/oracle/check-descriptor-transfer.mjs VM.WASM COMPILER.WASM \
  NEW-DIRECTORY/fixtures NEW-DIRECTORY/native-observation.json
```

Existing output directories are refused. Native test execution is only an
oracle, never the browser product path.

VM: 37,521 bytes, SHA-256
`198f9212f153b636e1de30fd85b8252b9edbd30c5f1bfe4ba8cfbda77949692c`.
Compiler: 425,711 bytes, SHA-256
`43d5b92cdcc7cf73ebc08fabe81b3413a596adab5ac1455541b95dda5c1e8018`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and next gate

[The fresh actual browser receipt](2026-10-04-descriptor-transfer-browser.json)
records 136,209,181 retired / 68,766,028 admissions and zero manually listed
branch entries. Its trace retires SGDT exactly once at `0xffffffff8103af89`.
The actual browser then refuses `0f 00 d8`,
LTR AX, at `0xffffffff8103afa1`, selector 0x40. Close that common system-selector
boundary with precise descriptor admission, busy-bit update and TR-cache
publication. Do not set a known Linux cache, guess a fault or skip LTR.
TSS/IST and secondary exception delivery remain separately open.

Linux/PID 1/shell and the complete development/storage/network product gates
stay red. Full decompression remains 14,622,864 bytes / 3,571 pages, SHA-256
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Eight #PF and seven #GP events enter Linux's own handlers. Twenty-two clock
events do not prove clock calibration or boot readiness.

Delivery remains 49 ranges / 3,154,432 fetched / 3,046,912 requested bytes,
65,536 cache high-water. There are 4,325 supplies / 4,338 resident pages,
18,350,080 VM-memory and 1,048,576 cold-memory bytes. Source admission keeps
64 rows / 6,752 metadata bytes / zero source payload copies, with 67,554,454
hits / 1,211,575 misses. Engine residence is 64 modules / 20,153 retained bytes,
but 1,211,574 compilations and zero reported engine reuse remain a work cost.
Cumulative 400,613,203 emitted / 4,962,873,344 copied bytes measure work, not
resident memory, delivery or native artifact size.

Cold/engine/execution/admission/supply observations are 17,129.6 / 100,174.5 /
35,678.6 / 22,525.6 / 221.3 ms. Other checks overlapped; these are not a
controlled speed comparison or cold-shell latency. Sampled guest clock events
can alter calibration branches, so retirement differences between runs are
not speedups or a boot completion percentage. Fixture SHA-256 is local
diagnostic integrity, not signed-root/AEAD/ECC production admission.
