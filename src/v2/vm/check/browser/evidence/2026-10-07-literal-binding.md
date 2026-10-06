# Single literal transfer topology — 2026-10-07

This candidate follows the completed same-bundle
[idle/quota run](2026-10-06-node-startup-idle-quota.json), not a new successful
Linux run. Cold/engine construction consumes 74.39% of that run. Source
misses reconstruct before exact emitted-byte lookup; 69,748,248 engine hits
still paid that preceding reconstruction. Whole ELF remains -104.

## A concrete missed quotient

[Candidate receipt](2026-10-07-literal-green.json):

A single MOV-to-GPR differs across values only by its literal binding. The
existing machine entry already accepts one attested 32-bit scalar binding.
Values represented exactly by unsigned32 or sign-extended32 now use that
binding, not a separately encoded constant body. Destination/width/source
length and signedness still belong to the compiled topology. Narrow writes
retain the old parent and 32-bit writes define the full zero-extended parent.

This does not merge unequal results: each source coordinate retains its exact
binding in C. The ordinary compiled function applies it without an opcode
switch, source reread, guest interpreter or new execution format. ABI/quotas,
VM bytes, published native bundle and human UI are unchanged.

Multi-instruction slices retain their literal definitions and are NOT split
to obtain a cache hit. A later supported instruction clears the tentative
single-value binding; a final branch retains its existing displacement
binding. Full-width64 values not representable in the existing scalar word
retain their exact literal body. This is a storage/body identity factorization,
not a claim of complete scalar normalized-SSA backend consumption.

Old compiler is independently red at value 1: returned binding 0, required 1.
The native check captures 1,024 real GPR/full-flags observations over
8/16/32/64-bit widths, high-byte aliases and boundary/wide values, including
930 equal-topology pairs. RSP writes cannot safely use its return harness.
Cold-C bytes match all 1,024 native-C emissions; direct and actual C-MMU/table
dispatch each agree with the full CPU model. 1,009 rebound values additionally
check the parameter family, separately from native observations.

## Construction comparison and limits

The existing rotating fresh-first engine test preserves all 2,304 CPU
comparisons and its one-entry/64 KiB owner. Six rounds of 128 different
MOV32 values previously required 768 body constructions / zero owner hits.
They now require six body constructions / 762 exact owner hits, with no quota
increase. Module size in that fixture is 237 -> 234 bytes. Sampled owner time
is 17.67 -> 2.32 ms; micro-timing is environment-sensitive, not Linux speedup.

At execution, `local.get` plus integer extension replaces `i64.const`.
This can add a Wasm operation to a tiny transfer. Therefore this candidate
does NOT prove minimum generated work/span, faster native x86 execution or
faster individual Wasm calls. Its verified benefit is repeated engine/body
construction elimination for this exactly bounded family. Real execution
cost and broader Pareto/normalization remain obligations.

Full native Wasm-compiler checks and scoped ASan/UBSan rebuilds pass. Existing
source/cohort, counter/fault, register-update, 464 native/vector fixtures,
28-function mixed module and C Artifact regressions pass. Same bundle's short
prefix retains the complete independent 86-instruction checkpoint and
1,617,931 retirements, then its old quota; no browser/Linux shell acceptance.

```text
compiler.wasm 457,557 bytes
f4cbe0ed2336a19a505d2142a9ece3e32e1f6d6a4b0c4fc3990b68c79d82c639
unchanged vm.wasm 81,547 bytes
0a8ee799638de906a4d87e4496e7be25ee4e46241882bc5de71b6dc8d34777b4
```

## The dominant remaining path

This factorization still invokes the cold compiler on every source-owner miss.
Complete compiler-produced module/coordinate projection and authenticated C
Artifact lookup/residency must replace reconstruction of already compiled
transfers. Observed RIPs or an enlarged prefix cache cannot substitute for
whole-image/executable-generation closure. Do not increase source/engine/
execution quotas to claim the 3-second cold-shell goal achieved.

The exact bzImage payload is the authoritative code/symbol input, not a
mutable build cache's current vmlinux/System.map. A diagnostic extraction now
reuses the existing checked kernel/gzip oracle. Actual payload SHA-256 is
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Its program headers, rather than absent section/code symbols, define bytes.
No extracted host bytes enter guest execution. Debug/source correspondence,
s6 readiness and real-browser development/storage/network acceptance remain
unproved; no native distribution or delivery-size improvement is claimed.
