# Byte concatenation as a static coordinate projection — 2026-10-10

Actual apk/SHA-256 execution stopped at PALIGNR. The shared frontend now
substitutes its immediate into the existing byte-coordinate projection; no
SHA helper, opcode interpreter or guest instruction skip is added.
For output byte i and unsigned immediate n, k=i+n:

* k<16 selects source[k].
* 16<=k<32 selects old destination[k-16].
* k>=32 selects zero.

Equal registers substitute equal owners before emission. Count0 borrows only
the source; count16 leaves a register destination unchanged; count>=32 needs
no result input. Other counts spell one ordinary Wasm SIMD static shuffle.
No concatenated payload array or per-lane runtime dispatch is materialized.

Value liveness never erases an architectural memory fault. Every admitted
m128 form still performs the same aligned16-byte C preflight, even when its
bytes do not contribute to the result. This follows the
[Intel PALIGNR contract](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf).
The common address model now passes576 flat/FS/GS differentials with384 exact
page-wait/retry continuations, plus five explicit unaligned #GP cases for
counts0/4/16/32/255. They are ISA models, not native fault observations.

All256 immediates, register alias and ordinary address-prefix forms pass
131072 independent actual native full-state / emitted C-VM comparisons;
2048 modules. The shared constructor adds768 register/alias/memory models,
12806 total static-coordinate cases. MMX PALIGNR is NOT added by this change.

Final compiler SHA256
`087fb8319595f82331bbaf17d460daa334a3047ad6763ae8fa1c252c5de4799b`,862963 bytes.
The final build repeats the131072 full-state comparisons and exact address
models. Independent full C/ASan/UBSan pass151877ms, source
`954162c988ee5b20e73ef1aae22842753fc8217b82e29c65a431fa780134f2e5`.

The retained real Linux shell prints Git2.55.0, Make4.4.1 and apk's musl
package information. Real job control pauses GCC/cc1 with SIGTSTP and resumes
the same processes using fg. fg returns0; the real18592-byte ELF prints vm-ok
and exits0. GNU Make-j4 runs four POSIX sleep1/echo jobs with strict && failure
propagation and returns0. git init and git status return0; apk info musl reports
musl1.2.6-r0. An earlier fractional sleep0.05 was unsupported and its semicolon
recipe hid the failure; that attempt is NOT used as the Make acceptance gate.
This diagnostic rescue/manual-warm environment is NOT normal automatic
cold-ready, the3s target or a signed release publication. Full parallel GCC,
network, COW publish/reopen and the broader syscall suite are not claimed.
