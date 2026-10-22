# Memory condition stores — 2026-10-03

The full browser product goal remains active: the same native bundle must reach
Linux/PID 1/offline shell and bundled development tools, then authenticated
storage/workspace recovery and granted NIC use. Component pass is not boot.
Native publication and human UI are unchanged; cold shell three seconds is unmet.

## Common lowering and red/green evidence

The preceding actual refusal `0f 94 44 24 2e` (`SETE [RSP+0x2e]`) is addressed
by all 16 memory SETcc conditions, not a kernel-coordinate special case.
32 acceptance cases (each condition x 32/64-bit address) first failed. They
now pass with exact one-byte write-only reports, no GPR/flags write, plus the
actual RSP encoding's stack-access report. LOCK and unsupported FS/GS bases
remain explicit grammar refusals without output mutation.

The predicate uses the existing register condition SSA. Its boolean value is
converted once to the byte store's value and crosses the existing C-MMU access
boundary. No reservation/read/atomic callback is required. Both truth values
write; false does not bypass fault checks. Flags and GPRs are preserved, and
RIP/retirement publish only after a successful store.

[Intel SDM Volume 2B](https://cdrdv2-public.intel.com/782151/253667-sdm-vol-2b.pdf)
defines both truth-value assignments, unchanged flags, fixed byte width and
ignored ModRM.reg bits. Those details are also checked with actual native
observations, not just the compiler's own expectation.

25 ordinary linked -> optimized ELF -> verified proof fixtures pass 12,800
complete CPU/RAM comparisons, 12,288 actual protection-fault comparisons and
25,088 RF checks. They cover every condition, all 64 arithmetic-flag combinations
(including irrelevant AF), then random flags, page-first/last byte, inaccessible
and read-only pages, address-size 32, SS, R12, SIB, extended indexes, RIP,
ignored ModRM.reg and operand-size/REX.W prefixes. A one-byte operand cannot
straddle pages; testing the last byte verifies no speculative next-byte access.
The native harness covers the SS/RBP address forms, not a forged RSP payload;
the RSP encoding is separately checked at compiler admission and real startup.

Native observations run in the reference build VM, not physical hardware.
These broad comparisons use generated cuts -> actual C MMU directly, not
separate C dispatch or complete exception entry. Two additional actual cold
SETcc emissions separately run through C source ownership and table dispatch.
The false arm writes zero over an already-zero source byte; BOTH truth values
retire once and invalidate source reuse before further dispatch. Including
previous source/CMPXCHG regressions, the current driver makes 16 actual cold
compile/install operations and rejects shared-memory linking.

Full product checks, 395 native/cold C-Wasm byte-identical emissions and selected
compiler/lowering ASan/UBSan pass without captured warnings or sanitizer
diagnostics. Linked decoder/provider/support archives in the selected sanitizer
run remain normal builds, not whole-TCB sanitizer coverage.

```sh
data/oracle/prepare-memory-condition-cuts.sh NEW-DIRECTORY
node data/oracle/check-wasm-provider.mjs VM.WASM NEW-DIRECTORY
node data/oracle/check-source-admission.mjs VM.WASM COMPILER.WASM
make -C src/v2 -j2 check
```

Fresh compiler: 418,345 bytes, SHA-256
`c0bc852daa9def05a5ae7cc332ee86f13027ffd21f1781cdbb84da1131d9aa17`.
VM remains 31,653 bytes, SHA-256
`cf42f4c9d83338c534c4eec5ddff389f5d5b9cca5b8f0b318077f02839675f4e`.

## Actual browser

Visible bounded receipt: the
ordinary-memory Worker passes SETcc and executes 129,387,892 source instructions /
64,571,332 admissions, with 64 live slots and no manually listed branch entries.
All 14,622,864 decompressed bytes / 3,571 pages remain equal to independently
gzip-validated page hashes before guest PT_LOAD moves. Seven observed #PFs and
three #GPs enter Linux's own handlers. These counts are not a boot percentage
or exception completeness proof; `linuxBoot=not-achieved` remains the result.

The next unretired `-102` is `48 0f ab 3d 2c f1 89 00` at
`0xffffffff81054a7c`: `BTS qword ptr [RIP+0x89f12c],RDI`. RDI happens to be zero,
but the common implementation must also handle signed register indexes that
cross memory-word boundaries. The existing immediate bit form deliberately
does not claim that address adjustment. PID 1/shell and full development,
authenticated storage and network acceptance remain red.

3,680 page supplies / 3,693 resident pages; VM/cold memories are
15,728,640 / 1,048,576 bytes. Source cache: 64 rows / 6,752 metadata bytes /
zero payload copies, 64,156,454 hits / 414,879 misses. Engine cache: 414,878
compilations / zero body hits, retaining 64 instances / 21,121 module bytes.
The observed largest buckets are engine 39,885.6 ms, execution 31,245.9 ms,
source admission 20,190.5 ms, cold construction 6,529.8 ms. This is a single
longer-path observation, not a controlled speed comparison or cold-ready time.
144,373,913 emitted bytes / 1,699,573,760 copied code bytes are cumulative work,
not resident or delivery sizes.

Object transport: 49 ranges / 3,154,432 fetched bytes / 3,046,912 requested,
65,536-byte high-water cache. Diagnostic fixture/module/output-hash requests
are excluded. Local hashes are not signed-root/AEAD/ECC production admission.
The native archive remains 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
