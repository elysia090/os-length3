# C-owned interrupt boundary — 2026-10-04

The same published native bundle now passes the previous STI compiler refusal.
The [actual browser receipt](2026-10-04-interrupt-browser.json) reaches UART
`OUT DX,AL` at `0xffffffff812638a6`, port `0x3f9`, with 137,325,900 retired
source instructions and 69,466,407 admissions. No CPU instruction is skipped.
PID 1, shell, Linux tooling, workspace/network acceptance and cold shell
3 seconds remain **unachieved**. The diagnostic's `status: pass` means its
bounded assertions passed, not Linux boot. Native release and human UI are unchanged.

## One architectural boundary, no duplicated execution path

Generated CLI/STI call `machine.interrupt_flag(port,enable)`. C checks the
admitted long-mode contract and CPL/IOPL before publishing IF or #GP(0).
The old inline CLI privilege/IF implementation is removed. Generated code
still owns successful RIP, RF clearing and retirement; C imports neither
source bytes nor a source decoder.

Derive the persistent inhibition state from the two distinct effects:

```text
shadow in {none, MOV-SS, STI}
new STI shadow = STI iff old IF=0 and old shadow=none
new MOV-SS shadow = MOV-SS iff old shadow=none
old shadow survives any residency/clock wait and a non-retired fault
old shadow is consumed by exactly one successful successor
```

STI inhibits maskable interrupts; MOV SS also inhibits debug exceptions.
Consecutive inhibition instructions cannot restart this one-successor interval.
One discriminated word replaces two countdowns. Segment ABI version 2 retains
the same 136-byte extent/cache offsets and rejects v1/unknown kinds. The
compiler and all native/cold test contexts use the same ABI. Exact suspend
must retain the discriminant along with CPU/hidden segment state.

C clamps inhibited source queries to one instruction and also rejects a
multi-instruction execution row while inhibited. Supervisor-only `vm_boundary`
drains an eligible PIC event **before** cold source projection can report a
fetch fault. `vm_run` and its fetch boundary use that same event owner. A
previously started instruction resumes first; an event never replays it or
executes an old source row at the handler RIP. JavaScript only transports the
C-selected page/clock request and observes the result.

## Bounded IRQ entry and physical retry

PIC priority/masking/cascade acknowledge selects one vector. The C owner
acknowledges once, then shares the existing IDT/GDT/MMU entry logic with
processor faults. An external event pushes **five** words, no error code
even at a vector normally used for an exception, and leaves CR2 unchanged.
Ordinary instruction-boundary IRQs save the actual RF; fault entry sets RF.
Interrupt gates clear IF; trap gates preserve it. Successful entry clears
inhibition and changes RIP/CS/RSP/flags without instruction retirement.

The existing bounded frontier adds one external-kind word: 168 bytes, not
a full machine snapshot. It pins the selected target, cache, original context,
frame and completed-store count across page waits. Stores may alias their
own IDT/GDT or paging structure; resume must not reread a replaced gate,
acknowledge again or replay completed stores. Close/rebind revokes the frontier.
Unsupported CPL changes, IST/TSS, CET, active debug, NMI/APIC and secondary
double/triple-fault escalation remain explicit incomplete contracts.

The primary reference is the [Intel SDM volume 3](https://cdrdv2-public.intel.com/835758/325384-sdm-vol-3abcd.pdf),
sections 7.8.1/7.8.3 (inhibition and interrupt entry) and 19.3.1.1 (RF).
The installed QEMU 11.1.0 TCG oracle sets RF in the external vector-32 frame
in all 192 independent records. That differs from Intel's ordinary-boundary
rule; the [QEMU implementation](https://github.com/qemu/qemu/blob/master/target/i386/tcg/seg_helper.c)
also shows the fault-classification `set_rf` path for hardware vectors.
This discrepancy is **explicitly excluded**, not copied into CPU input or
hidden under an equality claim. RF=0/1 preservation has separate model tests;
physical-hardware RF entry has not been measured. The source link describes
the implementation mechanism, not a pinned source digest of the installed oracle.

## Red and verification

* STI emission first returned grammar error -102 with the old compiler.
  Common C lowering now passes native and cold emission. No guest bypass.
* C-native IF/IOPL matrix: 768 complete CPU/segment cases, 8 unsupported-profile
  refusals and stale generation. C-Wasm generated CLI/STI: 768 cases, including
  288 precise #GP(0), old shadow, arithmetic flags and RF retirement.
* Actual C RTC IRQ8 -> PIC -> generated dispatch -> IDT/IRET: 96 cases with
  vectors 0/8/40, both gate types and 16 stack alignments. Clock waits retain
  STI inhibition. Repeated STI, MOV SS, CLI and NOP successors are checked.
* Independent Multiboot PIT/PIC fixture: 192 records across six instruction
  sequences, two gate types and 16 alignments. Handler count and saved RIP
  prove the oracle's inhibition position. Frame/RSP/IRET observations agree
  except the documented saved-RF discrepancy; this is not a CPL/IOPL oracle.
* Native C event tests: 64 vector/RF entry/retry/return cases, plus a partial
  frame overwriting its IDT before a missing stack page is supplied. Existing
  96 independent fault-entry/compiled IRET records remain green in C-Wasm.
* Eligible IRQ vs unmapped source priority, shadow extent, v1 rejection,
  bad-gate EXT error, stale records and no-ack refusals pass. A sampled RTC
  instruction finishes before the new IRQ; a deliberately invalid guest IDT
  then produces precise #GP rather than retiring the next instruction.
* RTC 4,479 CPU/segment, PIC 6,658, I/O 3,328, paired exchange 18,432 CPU/RAM,
  XADD/XCHG 38,912 CPU/RAM and source admission 23 real emissions remain green.
  Newly generated shipped kernel/BusyBox prefix and arithmetic/ELF fixtures
  give 169 byte-identical native/cold emissions. Initial bzImage state/pages
  and 20 borrowed-code export cases pass.
* `make -C src/v2 check`, all C VM core ASan/UBSan tests, and compiler
  code-cut ASan/UBSan pass without warnings. The latter links normally built
  decoder/provider archives; it is not whole-toolchain sanitizer coverage.

Reproduce the independent event observations separately from product execution:

```sh
bash data/oracle/prepare-interrupt.sh /absolute/test-output
qemu-system-x86_64 -machine pc -accel tcg -m 32 \
  -kernel /absolute/test-output/entry.elf -net none -display none \
  -serial none -monitor none -debugcon file:/absolute/test-output/rows.txt \
  -device isa-debug-exit,iobase=0xf4,iosize=0x04 -no-reboot
node data/oracle/check-interrupt-provider.mjs VM.WASM COMPILER.WASM /absolute/test-output/rows.txt
```

`isa-debug-exit` deliberately returns nonzero. Require exactly 192 valid
records, their sequence positions and one handler per record, not exit-zero.

## Actual browser measurements and remaining dominant cost

```text
vm.wasm       53,263 bytes   SHA256 04b521fe1936b32cfc997663c1f3696cf19682fc1f4e676ba1cc3840c1d29204
compiler.wasm 430,601 bytes  SHA256 067d12afd08d1ede2c59d3a055b881b068744a64bec11a2bb97d9445b6fefe5f
native bundle SHA256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

The standard in-app browser used ordinary memory, no cross-origin isolation.
Complete pre-move decompression still matches 14,622,864 bytes / 3,571 pages,
SHA256 `6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
There were 49 fetches / 3,154,432 fetched bytes / 3,046,912 requested bytes;
transport cache high-water 65,536 bytes. VM linear memory is 18,874,368 bytes,
compiler memory 1,048,576 bytes; these are not browser RSS.

This run observed **zero external IRQ entries**, so the provider/oracle checks
above must not be relabeled as IRQ use during Linux boot. 217 clock replies
and C-owned RTC/PIC state occurred. The unsupported UART returns ENTRY_MAP;
the record's previous #GP metadata is stale, not a new UART exception.

Source reuse has 68,071,303 hits and 1,395,104 misses, retaining no copied
source payload. Engine reuse remains **zero**. Engine construction 122,203.5 ms
is the largest measured phase; execution 39,067.2 ms, admission 23,581.0 ms,
cold compiler work 20,810.9 ms and supply 254.9 ms are separate. Emitted bytes
487,158,905 and copied code bytes 5,715,394,560 are cumulative work, not resident
storage or distribution transfer. Neither functional progress nor an extra
boundary check is a speedup claim. Next: C-owned UART and further common
machine/ISA admission, then actual PID 1/shell/toolchain acceptance; bounded
engine identity reuse remains a recorded fixed-cost optimization.
