# One body, exact residual memory frontier — 2026-10-10

The former boundary forced a pure address/value calculation and its following
plain load/store into two independent emitted bodies and source admissions.
They now share one body when the prefix is pure, the following operation is a
plain GPR MOV/MOVZX/MOVSX, and all code stays on one executable page. Other
memory/system/stack/atomic/string operations retain their established owner.

The memory frontier is NOT erased. Immediately before its sole access, only
GPR parents actually changed by the prefix, its full live flags, memory RIP
and exact prefix retirement are committed. A fault/wait therefore exposes the
same CPU/RAM state as separate execution. Final success commits only the
memory instruction's changed GPRs/RIP/one retirement; neither prefix retirement
nor its state is published twice. RF clears on actual successful prefix
retirement; unsupported AC is refused at the same later memory frontier.
TF/debug/shadow, page-bound fetch and source-generation gates remain intact.
No CPU image, copied payload, new VM operation or source-coordinate exception
is introduced. Binding a first MOV literal is disabled once it participates
in a larger expression, exactly as for existing pure multi-instruction slices.

Thirty-six actual compiled split/fused C-VM comparisons match all1256 CPU bytes,
physical code/table/data bytes and fault fields. Cases cover changed value/
address/flags, narrow/sign-extended parents, non-present/protection/noncanonical
faults, AC refusal and exact page-wait/commit/replay rejection/retry. These are
differential ISA models, not independent native hardware observations.
The former single-instruction wait retains its C row; the fused prefix ends
at its newly committed memory RIP and is admitted afresh without replaying
the prefix. Model calls drop2->1, or3->2 with an actual resource wait.

Same provider, same16-source-instruction ADD/store program,16384 iterations
per sample, seven samples:16 bodies/5248 bytes/37.0568ms median ->
8 bodies/4008 bytes/29.1423ms, ratio0.786422. Reset/bind/source/MMU/table work is
included. This is NOT a native hardware ratio, cold-ready measurement or a
global lower-bound claim.

Compiler bytes863854, SHA256
`0b4e1f74975ae97f7261fb17c69a3f881c87cff66091fcb919918c70f67ee0b3`.
Provider bytes120500, SHA256
`800ea277ea8904a18f0c03c0bf75ae095708b1c3170f83f6d05ac8dcdec27e51`.
The provider also refuses/wipes an unprojected entropy seed before arena open,
so saved boot plans never duplicate secret staging bytes;18 C-Wasm refusals
pass. Full independent C/ASan/UBSan pass158552ms, source
`71f99d5938a0783a352a3fbb3fd74910c10886ab57e32b1a8d8bca976942801d`.

The diagnostic demands one-source frontiers until its mandatory complete
decompression observation, then uses the same compiler at its normal bounded
grain. This is an observation demand, not a kernel/RIP-specific compiler rule
or another execution path. Existing86/378-state/relocation assertions pass;
the actual browser compares all14622864 bytes/3571 digests (SHA256
`c6f306ca0aee4c3c7d8f55204cd0959928399ba62943f46ea579ca83ce66274d`),
then enters Linux at129083023 retired. At135104112 it exposed a harness red:
the64th cut retired a two-instruction pure prefix before a page wait, so the
cohort had64 nonempty prefixes/107 retired instructions and no remaining cut
budget. Supplying the page must end that cohort and admit the pending memory
RIP afresh; a zero-budget resume would be wrong. The exact observed arithmetic
and the one-cut partial case now have explicit accounting checks.
The same ordinary root is being re-tested; automatic readiness is still not
claimed. Cold construction/decompression is NOT called faster from this change.
