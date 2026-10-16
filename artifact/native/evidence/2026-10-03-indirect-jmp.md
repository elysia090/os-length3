# Common indirect JMP and the shipped relocation trampoline

On 2026-10-03 the standard in-app browser ran `startup.html` with the same
published native bundle. It now reaches **391 retired source instructions**,
with the exact transfer `0x10002a1 -> 0x1e20d00` checked against the shipped
relocation trampoline. Its next compile gate is **REP STOSQ at `0x1e20d17`**
(`-102`). Linux/PID 1/shell and the three-second cold shell target remain red.
The [raw UI receipt](2026-10-03-startup-indirect-jmp.json) is a startup diagnostic,
not a boot certificate. Screenshot: `temp/browser-indirect-jmp-1003.jpg`.

## Shared lowering and the red that single-instruction tests missed

Near indirect JMP uses one C lowering for all 16 GPR targets and ordinary
32/64-bit memory addressing, including RIP-relative, SIB, extended registers,
and SS stack-address classification. Far control, indirect CALL, FS/GS memory
targets and invalid prefixes are refused, not treated as this instruction.

Memory targets first complete the eight-byte read through the actual C MMU;
only then is the loaded target checked for 48-bit canonicality. A pending #GP
does not publish CPU changes or retire the instruction. A canonical but unmapped
target retires the JMP and faults on the next fetch, not on the JMP. Fault metadata
is not exception delivery or CR2 mutation. JMP and RET share their canonical
target guard. Register JMP imports no host function; memory JMP imports only
the same C access boundary as other scalar loads.

An actual startup run exposed a planner bug: a pure LEA prefix was assigned
the CONTROL boundary of its *unemitted* indirect successor. That suppressed
fallthrough publication and sent RIP to zero. The native prefix regression
first failed; CONTROL now means a branch actually included in the cut. A
potentially faulting indirect successor leaves the prefix at LIMIT and is
compiled separately. Both a valid target and a later target fault preserve
the already retired prefix. The erroneous zero-page execution was rejected
as evidence of progress. The diagnostic now asserts the independent shipped
trampoline destination and retains a bounded transition/source receipt.

## Checks

* All-product `make -C src/v2 -j2 check` passes, including the new native
  branch check. It reproduces the original `JMP RAX -> -102` grammar red.
* **6,144 actual native x86 / C-Wasm dispatcher CPU comparisons**, including
  **768 actual #GP frames**, preserve every GPR and defined input flag.
  Exception-frame RF is explicitly separate from the pending ABI observation.
* **25 byte-identical native/cold modules**, 23 C-MMU fault-ordering cases,
  120 entry/stale/alias/bounds refusals and two prefix/fault compositions pass.
  The MMU ordering matrix is not relabeled as a hardware fault-delivery test.
* **181 fresh bundle/pure/repeat/branch native/cold emissions** match exactly.
  Historical fixture binaries are not regenerated in place or counted as new
  receipts. The new pure corpus also passes 41,984 native/C table comparisons.
* Existing C provider RMW checks pass 11,264 comparisons; REP passes 336
  native CPU/RAM receipts, 144 latch resumes, 192 refusal cases, 88 partial
  fault/miss cases and two code-alias continuations. PUSHF/POPF passes 8,192
  CPL/IOPL cases, 4,096 hardware receipts and 36 fault/refusal cases.
* Fresh compiler ASan/UBSan admission/code-cut checks pass, including near
  branch, prefix and rejected-family cases. The linked decoder/provider
  libraries in that build are normal builds; this is not whole-TCB sanitizer
  coverage. No sanitizer warning is hidden by a pipeline.

## Exact artifacts and remaining boundaries

The native bundle remains 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
The unchanged VM is 20,799 bytes, SHA-256
`d6b9f9a5732f90f9e1b7cfc5c9a9350a12eb1af53d598e065930a7a75dd8f6f8`.
The new cold compiler is 409,510 bytes, SHA-256
`b00212d1c29f7f063063c9ed95ccc5fcd5f00bdf3a14e776d3f9036c853645eb`.
Native distribution and human UI bytes are unchanged. No opcode interpreter,
address-specific execution shim, instruction skip or alternate kernel was added.

The ordinary-memory Worker used 195 demanded cuts and one live table slot.
All 3,040,256 relocated bytes still compare via C-MMU borrowed views. Physical
supply remains 1,481 pages / 1,494 resident pages, and 47 exact Range reads
retain one 64 KiB delivery chunk. VM/cold memories remain 6,815,744 / 1,048,576
bytes. Sample timing components exclude fixture setup/fetches and independent
observations; they are not cold shell latency or a speedup benchmark.

Next implement the common REP store frontier, then decompressor/startup ISA
and machine/device boundaries. Production signed root/AEAD/ECC admission,
dirty eviction/recovery, first-instruction cross-page supply, warm cut reuse,
whole-image closure and Linux development/network acceptance remain open.

```sh
make -C src/v2/wasm-compiler build/branch-check
mkdir NEW-BRANCH-DIRECTORY
src/v2/wasm-compiler/build/branch-check NEW-BRANCH-DIRECTORY
node data/oracle/check-branch.mjs VM.WASM COMPILER.WASM NEW-BRANCH-DIRECTORY
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM SHIPPED-STARTUP
node data/oracle/prepare-browser-startup.mjs VM.WASM COMPILER.WASM SHIPPED-STARTUP
# Serve the diagnostic and open /src/v2/vm/check/browser/startup.html.
```
