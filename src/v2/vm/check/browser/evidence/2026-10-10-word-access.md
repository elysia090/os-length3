# Exact physical words and linked C VM — 2026-10-10

The banked browser run reaches/run/service and the compiled service names,
but then reports `s6-rc-init: ... Operation timed out`, followed by
`Offline service transition failed; terminal remains down.` Subsequent relative
service-directory ENOENT messages do not by themselves prove a wrong pathname
implementation: the supervision transaction has failed. Its existing10000ms
deadline and the diagnostic clock contract remain unchanged.

The C VM's private word projection now uses constant-size, unaligned and
alias-safe builtin memcpy for2/4/8 bytes on little-endian supported compilers.
The source relation is exactly `sum(byte[i] << (8*i))`; stores are its inverse
on the same exact extent. No larger parent word is read for odd-width fragments.
Other widths/host endianness keep that same byte relation. Paging, full-range
preflight, A/D, fault priority and source write observation are unchanged.
This is a host C representation choice, not guest opcode execution in JavaScript.
The ordinary C VM Wasm build also uses link-time optimization; no second
provider, loader or ISA backend is introduced.

2097152 unaligned word/extent comparisons pass. Separate allocation-edge
guards pass ASan/UBSan; the complete independent Linux C checks and VM/compiler
sanitizers pass with source archive
`762a505bfd485c3b4304ea277c72bebef0c276936f8f2b9e7bbb44815249dd54`.
Existing49152 permissions/1920 cached-fresh walks/100000 RAM round trips pass.
The linked provider also passes196608 independent SSE and30720 FRNDINT
complete-state comparisons with the same cold compiler.

`benchmark-mmu.mjs BASELINE CURRENT` compares equal actual C-MMU workloads,
alternating order over7 rounds,250000 operations per sample. Median ms:

| operation | baseline | word/LTO | ratio |
| --- | ---: | ---: | ---: |
| read8 |18.5479|16.0479|0.8652|
| write8 |21.0832|18.0391|0.8556|
| cross-page read8 |25.4063|23.2938|0.9169|

Host import-call overhead is included. These are not Linux boot or native-code
minimum-work measurements. The provider size increases110272 ->119044 bytes;
do not equate its execution improvement with artifact-size reduction.
SHA256 of the new diagnostic provider:
`db0acb29b01e32b7d87d5a365c8b009e9c12b7c3e80c4d13f2c0c67c3ac02120`.

The next actual-browser run uses the same rebuilt kernel/init/root and an
engine byte index matching the existing2MiB construction-reference lifetime.
The earlier256KiB index repeatedly compiled topologies still referenced by
construction/source owners. No page payload quota, guest timeout, clock policy,
CPU profile or human UI is changed. Browser shell acceptance remains pending.
