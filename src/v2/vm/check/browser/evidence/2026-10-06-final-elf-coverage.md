# Final ELF coverage and shared precise cuts — 2026-10-06

## Inventory the product's actual inputs

`wasm-compiler --coverage INPUT.elf` opens the accepted optimized ELF and uses
the existing x86 catalogue to visit **every final PF_X byte coordinate**.
Interior bytes, padding and virtual zero fill are not excluded by symbols,
linear disassembly, proof counts or an observed trace. The catalogue now has
a fixed-CPU-profile entrance; native postlink analysis retains its original
entrance. Both share one enumerator and decoder.

At each coordinate the query measures the actual common cut backend. It
classifies lowerable code, genuinely unimplemented valid semantics,
unimplemented architectural faults, missing fetch context and output caps.
Its total must equal the catalogue's coordinate count. Invalid input and
output/source/owner aliases leave output unchanged. Coverage is **necessary,
not sufficient**, for publication. The CLI returns 3 for gaps and always
reports `publicationAllowed:false`; whole-ELF output still refuses -104.
No program interpreter, invented fault or alternative runtime was added.

The unchanged native publication is
`1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195`.
Bundle SHA-256 is
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
The already-opened root comes from system.squashfs
`6c7f0ea12300984eb1f9e9d4e33eef2be8db642e22afa9f776342a17a888bda9`.
Its manifest records development-standard-v1; these queries use the current
normative fixed x86 CPU bitset, not native host feature discovery.

Actual final files, not relinked test substitutes:

| Input | SHA-256 | PF_X coordinates | Before fault lowering | Current gaps |
|---|---|---:|---:|---:|
| usr/libexec/s6-ftrigrd | 3532d7a97ad486b76571ab66db73320e1795ce7158afd3fa45c2a37f900c027d | 61,555 | 6,089 | 1,790 |
| usr/bin/s6-rc-init | 4ffb086849110929e0e154fd142b5709967be92a4f70837acd1079516a0fba4c | 59,895 | 6,998 | 1,910 |

The before column is the earlier **uncommitted coverage candidate** on these
same files, not a published release or controlled speed comparison. Current
[ftrigrd](2026-10-06-s6-ftrigrd-coverage.json) and
[rc-init](2026-10-06-s6-rc-init-coverage.json) receipts preserve all counts.
Current gaps split into valid/fault 1,731/59 and 1,840/70 respectively; no
fetch/cap refusal occurs in these two images. Their first valid gap is `df e8`
(x87), not guessed #UD. Direct outside-image and indirect edges still need
load/control closure. These byte-coordinate reductions say nothing about
hot-path frequency, Linux speed, delivery size or working services.

The small actual compose-1.optimized.elf has 14 coordinates: the shared count
branch removes its former valid LOOPNE miss, leaving 12 lowerable and two
fetch demands at the executable map end. Those demands are not guessed #PF.

## Count/control law, not a Linux special case

The x86 owner defines count width, decrement and incoming ZF dependency once.
Native SSA and Wasm consume that same law for LOOP/LOOPE/LOOPNE/J*CXZ. Long
mode uses RCX or ECX according to address size; operand-size and REX.W do not
choose the counter. A 32-bit decrement zero-extends its write; JECXZ does not
write the parent register. No arithmetic flags are produced. The existing
signed displacement binding is used, not a new branch encoding.

A taken noncanonical target returns precise pending #GP before any tentative
counter/RIP/RF/retirement publication. A preceding successful prefix retires
separately. [Intel's instruction manual](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf)
provides the counter, target and flag contract (LOOP/LOOPcc entry).

[Counter receipt](2026-10-06-count-branch-green.json): 64 native/cold byte
parities, 8,192 native full-GPR/flags/count/target observations in both direct
Wasm and actual C-MMU/table dispatch. 8,192 RF, 128 shadow and 34 taken #GP /
46 not-taken cases are separate explicit models, not native #GP observations.

## Architectural fault is a compiled future

The shared x86 fault law admits only decoder-proven #UD/#GP, not truncation
or a legal unsupported operation. Failed decoding records the smallest
decisive non-FETCH prefix using the same configured decoder. Keeping all 15
available bytes would unnecessarily demand the next page before a fault
already established by a shorter prefix. The compiler emits one identical
#UD body across source encodings; the exact source extent remains admission
evidence, not another instruction stream.

Fixed-profile absent AVX/AES/XSAVE now produce #UD before operand access.
Native decoding still preserves those extensions for superset hosts. A legal
unimplemented RCL remains -102; incomplete source remains -105. Existing
negative tests explicitly distinguish invalid encodings from genuine grammar
gaps instead of accepting either result indiscriminately.

Six independent native page-end cases (invalid POP ES, LOCK NOP, UD2, LOCK
HLT, prefixed UD2 and 15-prefix overflow) fault #UD/#GP at the original RIP
before the inaccessible next page. [C-Wasm receipt](2026-10-06-fault-cut-green.json)
checks 36 direct and 37 C-dispatch cases, 38 fetch-priority cases, 145
reservation/grammar refusals and successful-prefix separation. Feature/RF/
shadow/MMU conditions are explicit models. Pending faults do not alter GPRs,
RIP, RF, retired count or interrupt shadow. A genuinely truncated 0f/0b
crossing requires the second page and respects its nonpresent/NX #PF priority.
Fault delivery/frame effects remain the ordinary C event owner's job.

## Verification and frozen scope

Full x86, postlink-compiler and wasm-compiler checks pass. Accepted-ELF
coverage totals equal an independent invocation of the direct catalogue;
invalid/reopen and alias controls pass. Source admission/cohort, mixed module,
464 native/cold vector fixtures and 224 independent system comparisons pass.

Postlink ASan/UBSan instruments its copied decoder/x86/support/ELF providers
and shared/native checks. A separate build-coverage-san instruments cold
emitter/interface/coverage/alias tests, including native count/fault and
mixed-module checks; its provider archives are regular builds. Neither is a
Wasm-engine sanitizer or browser observation.

```text
compiler.wasm 455,206 bytes
bf9e6cddceea09b5b48193d0cecaaa7a713555d4e59e6639da347c24e9f49de7
unchanged vm.wasm 79,421 bytes
d51851ad4b359a35851aca74a1b53d5810f036ca71ab56bf8e4f2032e4a8ca8e
```

The compiler is 1,896 bytes larger than the prior typed-module checkpoint.
Native bundle, UI, retained browser assets/Workers and quotas were not changed.
No new full Linux run or actual-browser result is claimed. The last same-bundle
run still had s6 Broken pipe/timeout and no usable terminal. Whole-ELF/control/
indirect/executable-generation closure, scalar normalized-SSA consumption,
compiled Artifact projection/residency, idle event transport, service failure,
browser development/storage/network acceptance and cold shell 3 seconds remain
open. Do not replace these with a finite selected-cut or coverage-only success.
