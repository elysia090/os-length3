# Memory-input signed multiplication — 2026-10-03

The same native publication/bundle and CPU profile remain the inputs. The
full goal is real-browser Linux/PID 1/offline C/make/Git/apk, authenticated
workspace persistence/recovery and granted Linux-network/service use. This
checkpoint is not boot or product completion. Cold shell 3 seconds is unmet.

## Red, derivation and common path

The previous real browser reached `0xffffffff81419204` and refused
`48 6b 05 64 1f 75 00 18`, IMUL RAX,qword [RIP+0x751f64],24. A general
two-operand memory IMUL fixture, built/linked/postlinked/proof-verified through
the ordinary CLI path, independently reproduced `memory cut refused (-102)`
before the lowering changed. Its optimized native ELF was already valid;
the missing connection was in the shared Wasm compiler, not the Linux guest.

The [Intel IMUL specification](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf)
fixes signed immediate extension, truncated two/three-operand products and
CF/OF overflow. SF/ZF/AF/PF are undefined, so comparisons choose their incoming
representative rather than demand a particular host's undefined result.

For width `w`, the normal form is:

```text
d = EA(old registers)                      # before aliased publication
m = precise_C_read(d, w/8)                 # even when the immediate is zero
(a,b) = two operands ? (old destination,m) : (m,sign_extend(immediate))
p = signed(a,w) * signed(b,w)
v = p mod 2^w
CF = OF = (p != sign_extend(v,w))
publish(destination := v, defined flags, RIP := fallthrough, retirement + 1)
```

The effective address and old destination stay in locals. A failed/waiting
load returns before arithmetic or any architectural publication. Existing
register-parent writes preserve the upper 48 bits at width 16 and zero the
upper 32 bits at width 32. Flat SS uses the existing stack fault classification.
The memory boundary receives only address/width/read/value; there is no
multiply opcode callback, host arithmetic or new VM interpreter.

Both register and memory sources now call one product/overflow emitter. Widths
16/32 use an exact i64 signed product. Width 64 uses the existing modular
32-bit-limb high product and signed-high correction; no i128 import, C signed
overflow, division or floating-point approximation is introduced. The common
flag frontier now recognizes both source shapes. Device/memory ownership stays
in C, multiplication stays compiled SSA, and the native distribution is intact.

Accepted forms are two/three-operand IMUL with 16/32/64-bit destinations,
32/64-bit effective addresses, ordinary GPR/SIB/displacement/RIP forms and flat
CS/DS/ES/SS. Implicit double-width IMUL, FS/GS memory bases and LOCK still
explicitly refuse; TF/AC remain existing entry refusals, not skipped faults.

## Verification

- 57 ordinary postlinked ELF fixtures: 29,184 complete native CPU/RAM success
  observations and 28,160 native load-fault frames. Immediate 0/1, signed byte
  boundaries and full-width immediates, minimum/maximum signed inputs,
  truncation/overflow, destination/base/index aliasing, RIP-relative and split
  pages are covered. The oracle is actual x86 user-mode execution in the
  reference QEMU TCG build VM, not physical-hardware evidence.
- Generated Wasm matches every observation through actual C vm.wasm/MMU.
  57,344 RF checks pass; success clears RF, pending faults retain it. Stale
  generation, closed provider, missing resident page, precise #PF and private
  arena bounds keep the original CPU and payload. The separate access test
  double also checks one typed load and no publication on refusal/wait.
- An optional read-only `--dispatch` mode in the existing provider oracle adds
  the exact source instruction to executable MMU pages and binds the actual
  C function table. 57,344 separate success/fault C-dispatch comparisons match
  the complete native CPU and unchanged payload, with exactly one or zero
  retirements. This test does not establish production source authentication
  or exception delivery.
- The shared register emitter still matches 32 modules / 16,384 native
  observations. 916 native/cold byte-identical emissions pass, including
  the previous I/O/POP/etc. regressions and repeats.
- Full `make -C src/v2 -j2 check` and selected compiler/lowering/native observer
  ASan/UBSan pass without warnings. Linked decoder/support/proof archives are
  normal builds; this is not whole-TCB sanitizer coverage. The old code-page
  test's memory-IMUL refusal was replaced by positive/fault-capable entrance
  tests and retained implicit-width/FS/LOCK refusals, not simply deleted.

Compiler: 422,778 bytes, SHA-256
`388f6738b16d536a9db35fc5acc08c810e95476a3bdfc251e4425456a692e195`.
VM: unchanged 36,584 bytes, SHA-256
`105c3be7eb19171c65b39f15922a5f9de6a1bc1849601a5521e701097fb08891`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

Reproduction uses `data/oracle/prepare-memory-multiply-cuts.sh` (new output
directory), then `check-wasm-memory.mjs`, `check-wasm-provider.mjs VM.WASM DIR
--dispatch` and `check-cold-compiler.mjs` on those receipts. Binary fixtures
stay ignored in Windows temp; no second native root or bundle is generated.

## Actual browser and next gate

[The actual receipt](2026-10-03-memory-multiply-browser.json) advances to
134,840,258 retired / 67,826,812 admissions. The memory IMUL coordinate no
longer refuses. Independent complete decompression is unchanged at 14,622,864
bytes / 3,571 pages, digest
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Eight #PF and seven #GP events enter Linux's own handlers. Ten diagnostic
clock events do not establish Linux's selected calibration frequency.

The next grammar refusal is `48 f7 ff` (IDIV RDI) at
`0xffffffff81413f53`, with RDX:RAX = 0:0x12355b and divisor 0x1f4. Common
register division currently covers only 8/16/32-bit operands; extend its
precise #DE and compiled quotient/remainder path to the full 128/64 case.
Do not special-case this guest coordinate or only sign-extended dividends.

Delivery stays 49 ranges / 3,154,432 fetched / 3,046,912 requested bytes and
65,536 cache high-water. VM/cold memory stays 16,252,928 / 1,048,576 bytes.
There are 3,747 supplies / 3,760 resident pages, 64 source rows / 6,752 metadata
bytes / zero copied source payload, and 64 retained engines / 21,501 bytes.
Cumulative emitted 375,091,323 and copied 4,646,543,360 bytes are work, not
delivery or RSS. Cold/engine/execution/admission/supply observations are
15,824.0 / 92,663.3 / 34,275.8 / 22,061.2 / 185.1 ms, not a controlled speedup
or cold-ready result. Boot/offline tooling and authenticated workspace/network
use remain unachieved.
