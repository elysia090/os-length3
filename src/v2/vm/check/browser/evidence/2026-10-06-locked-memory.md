# Serialized locked RMW uses the same transaction — 2026-10-06

The completed `5610a5f` unchanged-bundle Node run passes register XCHG and
reaches compiler -102 at `0x7fc71de30801`: `f0 48 09 14 c8`, LOCK OR qword
[RAX+RCX*8],RDX. It retires 181,874,281 source instructions / 93,957,446
admissions, not a successful PID 1 or shell. See the
[completed receipt](2026-10-06-node-startup-locked-or-red.json).
Engine construction 261,443 ms remains larger than cold emission 222,689 ms
and C execution 69,205 ms; total 695,534 ms. Frozen VM/compiler are 70,499 /
452,445 bytes; later reflexive exchange normalization was not loaded there.
Different retired work/active-execution clock calibration is not a paired
speedup. Retained browser Workers/staged assets were not changed.

## Missing entrance, not another executor

The decoder already supplies exact typed atomic descriptors for LOCK
ADD/OR/ADC/SBB/AND/SUB/XOR, INC/DEC/NEG/NOT and register-indexed BTS/BTR/BTC.
The existing arithmetic, flags, bit-address and unary lowerings already
operate on local SSA after the same C reservation. The old entrance allows
only atomic XCHG/XADD/CMPXCHG; it rejects these other descriptors before any
SSA is emitted. The frozen old compiler fails the fresh exact 484 fixture
with -102, and the new general C admission tests are red before the change.

For a pinned effective address A and n-byte operand, substitution yields:

```
EA, source, carry = read current architectural inputs
(physical fragments, old) = reserve(A, n, READ | WRITE)
new, flags' = existing SSA(old, source, carry)
commit(physical fragments, new)
publish flags', next RIP, retirement
```

Reservation preflights every fragment with write rights before reading a
value; a fault/wait cannot publish a partial store, flags or retirement.
Commit consumes the C-owned reservation. Ordinary non-shared Wasm RAM has
one synchronous guest owner. No guest writer, event or await occurs between
successful reservation and commit, so this transaction is indivisible in
the supported execution profile. Waiting occurs before that transaction;
the C continuation resumes the unchanged input after authenticated supply.
LOCK remains in the precise source metadata. It is not stripped to reinterpret
an unsupported instruction as an unlocked one.

The entrance checks the decoder descriptor against operation/width/source,
including high-byte GPR selection and signed immediate extension. Changing
any descriptor bit, removing LOCK, changing the machine effect or changing
the memory destination is rejected. Invalid LOCK register, CMOV, multiply
and LEAVE encodings remain rejected. At the `f1ab0fe` checkpoint,
immediate-indexed LOCK bit operations without a typed decoder descriptor
remain explicitly unsupported; the separately verified extension below
closes that entrance, not an execution fallback.
No atomic-op interpreter, new VM callback, import type, CPU field, memory role,
report word or execution row is introduced. Existing physical reservations
and the arithmetic/flag equations are reused unchanged.

This deduction agrees with the documented memory-destination LOCK families
and invalid-register rule in [Intel Volume 2A](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf)
and [Volume 3A](https://cdrdv2-public.intel.com/835754/253668-sdm-vol-3a.pdf).
It is deliberately not a proof of SMP/shared RAM, MMIO atomicity, enabled
split-lock detection, AC, HLE/RTM, arbitrary DMA or untrusted-host interposition.
Those require their own authority/order/profile contract.

## Counted checks

Fresh ordinary linked ELF -> native postlink compiler -> verified optimized
ELF -> C Wasm compiler records cover 91 forms: seven binary families at four
widths with register/signed-immediate sources, four unary families at four
widths, three register-bit families at three widths, and exact/scaled/aliased/
address32/high-byte/RIP-relative/full-width-immediate edge forms.

- 91 exact native-C/cold-C module and binding parity checks.
- 46,592 actual native success observations and C-Wasm comparisons.
- 46,080 actual protection-fault observations, including split pages and
  readable-but-not-writable operands; the single RIP-relative form has no
  native protection-fault rows, rather than a fabricated count.
- 92,672 separate C-dispatch comparisons (success and actual faults),
  92,672 RF models and 23,040 readable write-fault checks.
- 182 physical-residency waits/retries through C; these direct checks reopen
  the provider, and are not claimed as continuation-ticket coverage.
- Separate 34-family FS/GS metamorphic models include the 14 new LOCK
  families: 408 comparisons and 272 actual C latched supply/retry executions,
  including unchanged CPU/RAM and caller-row tampering. Of these, 168
  comparisons / 112 waits are the added LOCK families, not independent ISA
  observations. The 24 older independent FS/GS forms retain 1,024 direct and
  1,024 dispatch observations, 640 native successes / 384 faults.
- 536 atomic-descriptor mutation/refusal checks, fresh full native compiler/
  CLI checks, and scoped compiler ASan/UBSan checks pass. No new warnings.

Native observations execute x86 in the independent reference build VM,
not physical hardware; JavaScript builds inputs and reads observations,
not a product guest-instruction executor. Undefined logical AF and bit flags
retain the existing explicit representative; they are not mislabelled as
defined native results. A newly added unary address model initially encoded
[RAX] instead of [RSI]; its input was corrected, without relaxing comparison.

See [exact green receipt](2026-10-06-locked-memory-green.json). Compiler is
453,095 bytes (+609 from the reflexive-exchange candidate), SHA-256
`ad7ebb0b9fd0f72bea68bde786a12fafe002527b02c3b26e2f196d52ab6b3f9a`.
VM remains 70,499 bytes, SHA-256
`0c3142f523b4713e5034772569a73f32d6abe71f73c23d6da9bc45319c7e950f`.
The exact gate emits 452 bytes with five source bytes and no new runtime ABI.
This local green is not PID 1, root mount, shell, browser acceptance or a
release-size/speedup claim. The unchanged-bundle full rerun is a separate gate.

Reproduction:

```sh
bash data/oracle/prepare-locked-memory-cuts.sh NEW_NATIVE_DIRECTORY
node data/oracle/check-wasm-provider.mjs VM.wasm NEW_NATIVE_DIRECTORY \
  --dispatch --compiler=COMPILER.wasm
node data/oracle/check-segment-memory.mjs VM.wasm COMPILER.wasm FS_NATIVE_DIRECTORY
make -C src/v2/wasm-compiler check
```

## Immediate bit index closes the common decoder entrance

The next nearby red is a valid immediate LOCK BTS/BTR/BTC. The old C
decoder's atomic classifier accepts register indices only, even though
ordinary bit SSA already supports the immediate. Before the change, a new
positive cut/typed-descriptor test fails. This is separate from the observed
Linux LOCK OR gate and is not claimed as an actual next Linux stop.

The exact substitution differs from a register bit string:

```
register: A' = A + ((sign_extend(index) >> 3) & -(width / 8))
          bit = index & (width - 1)
immediate: A' = A
           bit = imm8 & (width - 1)
```

An assembler-selected displacement is already part of A, not another
runtime word displacement. The decoder now encodes the unsigned imm8 in
the existing atomic descriptor's immediate-source field. The same
admission cross-check and SSA bit lowering consume it. Register descriptors
are byte-for-byte unchanged; no new atomic opcode, VM callback or ABI field
is needed. Immediate indices never reach register word-offset lowering.

Independent common-x86 checks verify every imm8 at all three widths and
families through native and fixed-profile decoders: 4,608 exact descriptor/
source/effect checks. Both regular linked inputs and the cold C decoder
agree. Fresh optimized ELF proofs pass for all 118 forms (preceding 91 plus
27 immediate cases: 16/32/64-bit, indices 0/31/255).

The extended native/C VM oracle passes 118 byte-parity emissions, 60,416
success observations, 59,904 actual protection-fault observations, 120,320
C-dispatch comparisons and RF models, 29,952 readable write faults and 236
direct physical waits/retries. Separate 37-family segmented/latch models
pass 444 comparisons / 296 latched resumes; 36 comparisons / 24 resumes
are the newly added immediate families. Descriptor mutation refusals grow
to 603. Full common-x86 and compiler/CLI checks, plus scoped compiler
ASan/UBSan, pass. An intermediate new Make dependency accidentally supplied
a second `check` recipe; it was changed to its own phony target and all
checks rerun with no recipe-override warning.

See the [separate extended receipt](2026-10-06-locked-immediate-bit-green.json).
Compiler is 453,250 bytes (+155), SHA-256
`ae8a05c0e31e6f962f77965dae3872043a470a1b0f9cc944828268a912f037d0`;
VM remains unchanged. The running frozen `f1ab0fe` job (PID 20464,
`temp/locked-memory-1006/frozen`, warmCuts=64, unchanged quotas) contains the
453,095-byte compiler, NOT this extension. It was neither restarted nor
overwritten. No timing ratio, successful PID 1, shell or browser acceptance
is inferred from these isolated checks.
