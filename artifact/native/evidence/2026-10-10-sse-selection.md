# SSE selection and ordinary toolchain execution — 2026-10-10

The retained actual browser's guest GCC stopped on MINSD, then CMPSD,
MOVHLPS, SHUFPD and PMOVMSKB. These are construction misses, not #UD and not
permission to interpret/skip an opcode. The same CPU, RAM, device and clock
state survives each integrity/ABI checked compiler replacement. The human UI
and published native bundle are unchanged.

MIN/MAX reuse the raw IEEE operand classification. Comparison and DAZ happen
before selection. Equal values (including opposite signed zeros) and unordered
operands select source2; source2's signaling NaN bits are not quieted. Newly
raised IE/DE and the unmasked frontier publish through the existing SSE owner.
CMP's eight predicates reuse the same sign/magnitude/zero/unordered relation.
Only immediate bits0..2 matter. Quiet/signaling predicates have their distinct
IE behavior; flags and unselected XMM bytes remain unchanged.

MOVHLPS/MOVLHPS substitute source/destination offsets into the existing exact
8-byte transfer. A same-register half move is not identity. SHUFPD substitutes
each qword choice with two adjacent dword choices into the existing static
byte-coordinate projection; no new permutation runtime exists. PMOVMSKB and
MOVMSKPS/PD share the lane-sign mask geometry and ordinary Wasm SIMD bitmask.
MMX still publishes its architectural tag transition through the same owner.

Validation gates:

| Gate | Result |
| --- | --- |
| ADD/SUB/MUL/DIV/MIN/MAX numeric + MXCSR |196608 actual native comparisons|
| MIN/MAX complete C-VM/native state and unmasked faults |49152 comparisons,8 modules|
| CMP complete C-VM/native state and unmasked faults |196608 comparisons,512 modules|
| Half moves complete C-VM/native state, including alias |6400 comparisons,100 modules|
| SHUFPD complete C-VM/native state, ignored high immediate bits |25600 comparisons,400 modules|
| Sign masks complete C-VM/native state, MMX/XMM/REX.W |256 comparisons,8 modules|
| Arithmetic construction/malformed refusal |5440/65280|
| COMI/CMP construction/malformed refusal |27200/435200|
| Scalar/half/mask construction/malformed refusal |8192/216064|
| Static permutation construction/descriptor refusal |12038/246120|

The actual CPU observer captures RAX/flags/FPU/tag/MXCSR; other GPR invariance
is architectural. These counts are not a full release closure or a Linux boot
claim. PS/PD has a valid lane-width parameter with the same opcode/operand
shape; the constructor distinguishes that valid alternative from malformed
metadata instead of calling it a refusal.

Final compiler bytes862160, SHA256
`5f0503fbd4b2aa7466e4439770c8769ec00269cdaf5430215695a443fd5ae9b5`.
The unchanged C provider is118977 bytes, SHA256
`52f318dba4d5d25273d267942bf29ff1db126777f37ad7f418cef3b6d9a9e31f`.
Compiler size increases; no release-compression or global-minimum claim.

Independent full C/sanitizer checks passed before the half/mask additions,
source `afffc550c854da69552d3cae0892edbb802d0c54a3b48f1ddc5e65a8d3b4b358`,
154418ms. The final shared source also passes full independent C and
ASan/UBSan checks,149700ms, source
`c4dbe960c47e2021de25aa942f4ae7802dd95abc0d60e80c61c04f221c488e1b`.
Normal cold offline service transition is still red. The diagnostic rescue
shell and manual warm service transition are not substituted for that gate.
Real GCC completion and subsequent make/Git/package commands remain under
actual-browser test; no output or release update is inferred from progress.
The actual shell prints `git version 2.55.0` and `GNU Make 4.4.1` after the
foreground GCC job was suspended with the guest terminal's Ctrl-Z. Its148
status is a SIGTSTP observation, not a compiler failure or a successful build.
Jobs/proc inspection and `fg` are queued in the same real guest to resume it.
