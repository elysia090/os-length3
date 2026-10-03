# C-owned physical source admission — 2026-10-03

The full browser product goal stays active. Linux/PID 1/shell, offline C/make/
Git/apk, authenticated storage/recovery and granted networking remain open.
Native release and human UI are unchanged. This fixes a measured repeated
construction cost, not an ISA fallback, artifact-size reduction or boot result.

## Necessary reuse witness, without a payload copy

The previous [actual browser receipt](2026-10-03-startup-exception-entry.json)
copied an executable 4 KiB page and reran the C compiler on each of 1,000,000
admissions. Engine reuse checked identical emitted bytes, but could not remove
that earlier work. A source page is mutable and can alias page tables, so an
address-only JavaScript lookup, generation counter or assumed immutable code
would be unsound.

Under the existing serialized, pinned compiler/engine owner, a saved generated
function remains valid for the same `(entry, compile limit, compiler/profile,
physical source extent)` when its consumed source bytes cannot have changed.
This is a sufficient structural witness, not a necessary-and-sufficient
semantic quotient: equal-value writes or equal bytes in another physical owner
can conservatively miss. The compiler's exact source extent is a valid executable prefix; bytes
after its boundary are not part of that prefix's semantics. A different later
successor may change future grouping, not the already accepted prefix. No
lookahead-dependent omitted flag definition may enter this acceptance contract.

```
hit = executable_MMU_admission(current_entry)
   && same_entry_and_limit
   && same_physical_payload_owner
   && no_intersecting_physical_write_since_compilation
   && same_serialized_compiler/engine_lifetime
```

The C VM tracks 64 rows and two 256-word bitset indexes: source-key candidates
and physical-page write candidates. Candidate collisions always receive exact
entry/limit/offset/range checks; no hash equality proves reuse. Metadata is
**6,216 bytes**, with **zero stored source payload bytes**. Only live candidate
bits are walked, rather than scanning every row per guest store. Replacement
rank wraps only to replace an already invalidated slot, never as an authority
epoch. All CPU/MMU/segment state and residency are pinned by the serialized
owner; this is not a shared-worker atomicity proof.

Guest physical writes, MMU A/D updates and reservation commits notify C before
each payload fragment changes. Intersecting source spans are invalidated, even
on equal-value stores or a walk that subsequently faults. Unrelated bytes of
the same physical page do not revoke a completed source row. During async
compile/instantiate the final extent is not known, so the pending pin covers
the entire borrowed page; a write cancels publication even if it later changes
back. External host mutation/remap/table replacement requires explicit reset.
Current supply appends only virgin pages; no untracked eviction/remap is allowed.

Every query still executes the C MMU permission/residency walk before reuse.
Execution also retains its existing precise fetch/revocation checks. Hits bind
the previously installed typed table function; misses use the same independent
C compiler. JavaScript owns opaque engine handles and transport, never source
identity, decoding, branch selection or invalidation semantics. The cache is
scoped to one compiler/profile/Worker lifetime and is not a cryptographic proof
of an untrusted host-provided compilation. First-instruction crossing requires
separate two-page source admission and remains open.

## Actual browser comparison

The [new visible receipt](2026-10-03-startup-source-admission.json) has exactly
the same 1,616,430 retired instructions, quota RIP/CPU registers/flags/CR3,
guest #PF delivery, relocation/BSS/memset checks, source identities, fetch
counts and resident pages as the previous receipt. It is not Linux boot.
Proof screenshot: `temp/browser-source-admission-1003.png`.

| Measured work | Previous | C-owned source admission |
| --- | ---: | ---: |
| C compilation requests | 1,000,000 | 1,967 |
| C source reuses | 0 | 998,033 |
| Cumulative code transfer bytes | 4,096,000,000 | 8,056,832 |
| Cumulative emitted bytes | 338,352,494 | 654,648 |
| Retained engine instances | 64 | 64 |
| Retained engine payload bytes | 21,650 | 21,650 |

Code transfer work falls **99.8033%**. That is not resident-memory, distribution
compression or download reduction. Fetch remains 47 HTTP 206 ranges /
3,056,640 bytes; resident VM/cold memories remain 6,815,744 / 1,048,576 bytes.
64 generated slots, not one, are now retained and cleared on teardown.

Observed sub-timings change C construction 7,905.1 -> 40.1 ms and engine
3,560.5 -> 212.1 ms; execution 555.2 -> 502.6 ms. New source/MMU admission
is separately measured at 291.0 ms, supply at 156.4 ms. These are individual
observations, not a statistically controlled speedup or cold-shell latency.
The initial four-way candidate table thrashed into 58,276 misses; bounded fully
associative rows with bitset candidate indexing eliminate that avoidable cost.

VM is 28,419 bytes, SHA-256
`bf0b5560ad5c5aea4ff13bd5138ab3239a4291280ee4ff1d997530349453c1ae`.
Compiler remains 412,293 bytes,
`f784134a0618c3b72d650fba788e4702304754abdab62e495462a0cbe29e4355`.
Published native archive remains SHA-256 `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Red tests and verification

The actual RAM-store observer test failed before notifications were wired;
directly calling the invalidation helper alone was insufficient. Native tests
now pass 100,000 collision/replacement cases, exact-byte overlap, same-bucket
different-page writes, full-range invalidation, limit/owner/generation/reset,
pending writes, one-page end bounds, reservation commit, actual MMU payload
stores and a code/PML4 alias whose A update survives a later #PF.

The first actual browser execution trapped because the generated slot range
overwrote the new C observer's function-table slot. `vm_slot_min` now includes
every private callback, and the dedicated C-Wasm regression installs and runs
real generated NOP/CLC bodies, then performs an actual C write. It also checks
equal-value source mutation, a pending pin cancelled by another page byte,
reservation commit, stale generation, same-generation rebind, memory.grow and
NX permission refusal without output publication. All six real cold emissions
and reuse checks pass. The intentionally hostile unannounced PTE change in this
test proves permission checks still happen; it does not authorize ordinary host
mutations without reset.

Full product `make -C src/v2 -j2 check` and all linked C VM core/source tests
under ASan/UBSan pass. 96 system-oracle exception entries/generated IRETQ/RF
returns remain green with the new provider; carry and memory-CMOV regressions
remain separate semantic differentials. Sanitizing VM core is not whole
compiler/decoder TCB coverage.

```sh
make -C src/v2 -j2 check
data/oracle/wasm-tools.ps1 -Output temp/source-admission-1003/vm.wasm
node data/oracle/check-source-admission.mjs temp/source-admission-1003/vm.wasm temp/exception-entry-1003/compiler.wasm
node data/oracle/check-exception.mjs temp/source-admission-1003/vm.wasm temp/exception-entry-1003/compiler.wasm temp/exception-entry-1003/frames.txt
node data/oracle/prepare-browser-startup.mjs temp/source-admission-1003/vm.wasm temp/exception-entry-1003/compiler.wasm temp/startup-page-supply-1003
```

Next continue actual decompression with a larger explicit diagnostic budget,
then address the next common machine/compiler witness. Complete boot, shell,
production authenticated storage, dirty recovery and network acceptance remain
red. Local diagnostic SHA-256 is not signed-root/AEAD/ECC admission.
