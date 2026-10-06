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
and LEAVE encodings remain rejected; immediate-indexed LOCK bit operations
without a typed decoder descriptor also remain explicitly unsupported.
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
