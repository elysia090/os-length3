# System descriptor loads — 2026-10-04

The active product goal is the same shipped native bundle, through the
independent C cold compiler and C VM, reaching real browser Linux/PID 1,
offline shell, C build/run, make -j4, Git/apk, authenticated minimal-page
workspace recovery and granted NIC HTTPS/Git/service access. Cold shell
3 seconds remains unmet. Native release bytes, the CPU profile and human UI
are unchanged. No opcode interpreter, coordinate-specific skip or fallback
is introduced.

## Red and common boundary

The preceding actual browser stopped at `0xffffffff8103afa1`, `0f 00 d8`,
LTR AX with selector 0x40. Before implementation, all 144 compiler entrances
were red; the initial 8,269 C models produced 16,661 failed assertions.
Both LLDT and LTR now use the existing `machine.segment` descriptor owner.
Generated memory forms first compute the effective address through common
SSA and use the precise two-byte `machine.access` read. CPL0 is checked
before that source read. No source opcode, address decoder, known Linux
descriptor or host-selected TR value is passed into execution.

The accepted operands are 16-bit GPR or memory, including ordinary, 66,
REX.W and address32/64 forms. FS/GS memory operands remain an explicit
entrance refusal until the common effective-address path includes their
hidden bases. LLDT/LTR do not set the MOV SS interrupt shadow.

The descriptor owner checks null/TI, the complete sixteen-byte GDTR extent,
low system type and presence, then the upper type field. DPL/RPL do not
become invented access gates. Null LLDT invalidates LDTR; null LTR is #GP(0).
An invalid low type or absent descriptor precedes an upper-page fault.
The loaded base is retained, not dereferenced by LLDT/LTR; later LDT/TSS
access owns the canonical-address check. These details follow the
[Intel instruction reference](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf)
and [system-descriptor specification](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-3a-part-1-manual.pdf).

LTR reserves the entire sixteen-byte descriptor through the shared C-MMU
READ|WRITE preflight, re-reads after paging A/D effects, sets the busy bit,
commits through the existing write observer, then publishes the TR/cache.
The hidden TSS type is busy. The record API is bounded to sixteen private
bytes and uses the same reservation owner as scalar RMW. The scalar commit
cannot accidentally consume a sixteen-byte reservation. The private record
is not a descriptor dictionary or persistent CPU/RAM snapshot.

A physical-owner miss leaves the busy bit and architectural cache untouched;
the pinned input can restart after supply. Guest paging A/D effects may
remain. No payload commit is followed by another faulting operation. The
ordinary-memory owner serializes execution; this is not an SMP, task-switch,
TSS/IST or arbitrary MMIO implementation.

## Verification and oracle limits

[The C-Wasm receipt](2026-10-04-system-segments-native.json) records:

- 144 native C/cold C-Wasm byte-identical bare-page emissions: both operations,
  all sixteen GPRs, register-indirect/stack/extended-SIB/RIP-relative memory,
  ordinary/66/REX.W and address32/64. Five separate compiler-negative inputs
  refuse without output. These are executable boot-page fixtures, not an
  invented optimized-ELF proof.
- 153,360 models through actual C provider/MMU/dispatch, comparing complete
  CPU/cache/payload state: privilege, null/TI, DPL/RPL, type/S/presence, upper
  reserved type, loaded base, descriptor extent, source-read fault priority,
  cross-page presence/protection and RF/one-time retirement.
- 144 actual supply waits/resumptions with unchanged busy bit and pinned
  CPU/cache; duplicate page commit is rejected.
- 3,072 unique CPL0 system-observer rows, of which 3,024 match C-Wasm exactly.
  The remaining 48 are explicit reference differences: QEMU admits legacy
  sixteen-bit TSS type 1 in IA-32e, whereas Intel marks it reserved. Each
  quarantined row still checks presence, fault/error, busy mutation, STR and
  unchanged flags. They are not silently discarded or called matches.

The reference is QEMU TCG, not physical hardware. Its
[LTR/LLDT helper](https://gitlab.com/qemu-project/qemu/-/raw/master/target/i386/tcg/seg_helper.c)
does not make all Intel descriptor checks or perform the same whole-record
write. Hidden-cache contents and cross-page system faults therefore remain
explicit Intel models, not claims of complete observed hardware behavior.
The trace is 838,656 bytes, SHA-256
`e5df491b688337ce65bfca0e99fda159ae5c9f99ba9144ff34945029f79d8a79`.

Native C separately passes 8,274 models, including record-reservation abort,
size/generation mismatch, scalar-commit denial and write-observer counts.
All linked VM-core ASan/UBSan and selected full-lowering system/table
sanitizer checks pass. Decoder/support/proof archives in the selected
compiler run are ordinary builds; this is not whole-TCB sanitizer coverage.
Current 438 native/cold emissions pass. Old pre-RF-clear emission receipts
are stale and are not used as parity authorities.

Existing descriptor regressions pass 96 emissions / 16,128 models /
108 native observations / 216 waits / 2,244 refusals / 108 abort preservations.
Existing memory-division passes 72 forms / 36,864 comparisons /
73,728 waits/retries, and IO/clock passes 26 forms / 3,328 comparisons.
Source admission and page-supply regressions also pass.

The first full `make -C src/v2 -k -j2 check` failed in the pre-existing native
CALL observer: form 0, row 1, #GP, with the reference stack word unchanged.
An isolated rerun, three further isolated repeats and the second full run
passed. The cause of that intermittent reference observation is not resolved;
the failed run is not relabeled as green and no CALL semantics were changed.
The successful full run and sanitizer runs report no compiler warnings.

Reproduce in an ordinary x86 Linux test oracle:

```sh
bash data/oracle/prepare-system-segments.sh NEW-DIRECTORY
qemu-system-x86_64 -machine pc,accel=tcg \
  -cpu qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-xsave,-avx,-aes,-pclmulqdq,-monitor \
  -m 32M -nodefaults -no-reboot -display none \
  -kernel NEW-DIRECTORY/system.elf \
  -debugcon file:NEW-DIRECTORY/system.trace \
  -global isa-debugcon.iobase=0xe9 \
  -device isa-debug-exit,iobase=0xf4,iosize=4
node data/oracle/check-system-segments.mjs VM.WASM COMPILER.WASM \
  NEW-DIRECTORY NEW-DIRECTORY/system.trace
```

The directory must be new. The system observer signals successful termination
through isa-debug-exit (not ordinary exit status 0); complete-grid validation
in the checker is mandatory. QEMU is only a test oracle, never product runtime.

VM: 39,064 bytes, SHA-256
`5beb9930c252c76397b28b3db8737ccfbd8b1f29902ba31c920d99dfceea4499`.
Compiler: 426,912 bytes, SHA-256
`d897a7ead13b438f35fefd126522c347f02c781dd4c80ae6158e05f0a7ac17fb`.
Native bundle: unchanged 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and next gate

[The fresh actual browser receipt](2026-10-04-system-segments-browser.json)
passes the old LTR coordinate and reaches 136,209,819 retired /
68,766,303 admissions, with zero manually listed branch entries. It next
stops at `0xffffffff8103adf2`, WRMSR `0f 30`, ECX `0xc0000081` (IA32_STAR),
EDX `0x230010`, EAX 0. The source bytes were independently checked against
the decompressed optimized ELF's PT_LOAD. The result is ENTRY_MAP (6), an
explicit unimplemented MSR boundary, not a compiler opcode refusal or guest
#GP. The port's displayed vector 13/address `0xffffffff8140c03f` are stale
from a prior handled exception and must not be attributed to STAR.

Close STAR/LSTAR/CSTAR/SYSCALL_MASK through the existing fixed-rank MSR owner
and common generated WRMSR/RDMSR cuts, with privilege/reserved/canonical/reset
evidence. Keep syscall execution and TSS/IST fault entry separately explicit.
Do not invent reset-zero registers, patch the guest or widen the CPU profile.
Linux/PID 1/shell and all development/storage/network product gates remain red.

Full decompression is still 14,622,864 bytes / 3,571 pages, SHA-256
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Eight #PF and seven #GP events enter Linux's own handlers. Thirteen clock
events do not establish clock calibration or readiness.

Delivery: 49 ranges / 3,154,432 fetched / 3,046,912 requested bytes /
65,536 cache high-water. VM: 4,325 supplied / 4,338 resident pages /
18,350,080 memory bytes; cold compiler memory: 1,048,576 bytes. Source
admission: 64 rows / 6,752 metadata bytes / zero source payload copies /
67,554,670 hits / 1,211,633 misses. Engine: 1,211,633 compilations / zero
reported reuse / 64 resident modules / 20,461 retained bytes. Cumulative
400,632,180 emitted / 4,963,110,912 copied bytes are work, not resident RSS,
delivery bytes or native artifact size.

Cold/engine/execution/admission/supply observations are 17,389.2 / 100,842.9 /
35,458.7 / 22,495.7 / 207.5 ms. They are not a controlled speed comparison or
cold-shell latency; sampled clock events alter calibration branches.
Fixture SHA-256 is local diagnostic integrity, not production root/AEAD/ECC
admission. Bounded residence does not erase the repeated engine work cost.
