# Independent near CALL fault observations — 2026-10-04

Later independent Windows-native receipt:
[2026-10-05](2026-10-05-call-fault-windows.md), 426 untouched words among
884,736 calls outside the build guest. CPUID reports Hyper-V; not bare hardware
or allowed-effect proof. Product lowering/strict expectations stay unchanged.

## Product red and oracle provenance

The active Windows build VM was independently inspected without restarting
or changing it: process 22012, started 2026-10-02 20:56:13 local, runs the
pinned portable `qemu-system-x86_64.exe` with `-machine q35 -accel whpx`.
The recorded bootstrap execution configuration agrees. Its user-mode native
receipts are **WHPX**, not TCG. Earlier build-VM attribution in evidence prose
and raw JSON is incorrect; the historical bytes/counts are not rewritten.
Explicit system fixtures launched with `-accel tcg` are still TCG. No oracle
is a product execution route or a universal physical-CPU guarantee.

An unchanged strict `call-check` fails again at repeat 435 after 434 passes:

```text
CALL stack publication form=12 row=161 vector=13 before=5a5a5a5a5a5a5a5a after=5a5a5a5a5a5a5a5a
CALL inputs phase=1 target=8000000000000000 operand=0 stack=12340ff0 rsp=12340ff8 flags=613
CALL frame error=0 rip=400000 rsp=12340ff8 flags=10613 si_addr=0
CALL initial GPRs: fc1238424f40a5f9 30fe5bd9faac7af2 26f8b476d017de87 35470589a264b0fa 12340ff8 9600c724cf4debd5 a31847d6a2572542 7c3aa5e49629b88 95048ffb8759bcbf 152f2bb111a3c006 86957d76ef7c4606 86d97d3fab67ff0a 8000000000000000 176ec353a8682010 b0fe9d57f992f450 f6d0120ce726c5b8
CALL bytes: 41 ff d4
```

The target is in R12 and the stack word does not cross a page. Neither a
memory-target alias nor a cross-page store is therefore necessary for the
red. That does not establish its complete cause. The full repetition log is
scratch `temp/call-fault-1004/full-repeat.log`, not a retry-as-pass check.

## Independent minimization

`data/oracle/call-fault-observe.c/.S` uses only native libc, signal frames and
an assembly register trampoline. It has no product compiler, decoder, VM
state, C source owner or emitted-Wasm dependency. Six exact forms cover RAX,
disjoint/aliased memory, extended SIB, old-RSP and the reproduced R12 input.
Four stack ends include aligned, split and the reproduced 0x12340ff0 word.
Three incoming flag images and three preceding permission histories yield
216 groups. Both stack pages are writable **before** every tested CALL.
All 16 GPRs, RIP, RFLAGS/RF, vector and error are recorded separately from
payload. An untouched payload is counted, not silently accepted as equivalent.

| Independent observation | CALLs | Stored return word | Untouched word | Original CPU frame | Advanced RSP/RIP frame |
| --- | ---: | ---: | ---: | ---: | ---: |
| WHPX build VM, Linux 6.18.35-0-virt | 884,736 | 884,684 | 52 | 884,736 | 0 |
| Explicit TCG, same observer `/init`, shipped Linux 7.2.7 kernel | 110,592 | 110,592 | 0 | 0 | 110,592 |

WHPX has eight mixed groups. The earlier smaller matrix had 368,640 retained
stores and no untouched word; it was not proof that the intermittent red had
gone away. The strengthened matrix includes the exact later full-fixture
register input. The [WHPX raw log](2026-10-04-call-fault-whpx.log) and
[TCG raw log](2026-10-04-call-fault-tcg.log) retain every group and CPUID.
CPUID's APIC-id field can differ when the process migrates across reference
vCPUs. No exact CPU-feature/profile equivalence is inferred from these runs.

TCG uses the exact same static observer executable in a diagnostic initramfs,
not the published root or product shell. It is networkless and terminates via
the isolated process's `-no-reboot` boundary. Its frame differs: RSP is already
decremented and saved RIP is 0x8000000000000000 rather than 0x400000. The
observer's `status: observed` is not an equivalence pass. The kernels differ
between these two reference runs, so accelerator alone is not proved causal.

## Primary references and remaining obligation

The latest [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
revision 093 was obtained from its official links. Volume 2A's near absolute
CALL operation orders the return-address push before RIP assignment (3-126),
whereas Volume 3A classifies #GP as a fault with a saved pointer to the faulting
instruction and describes program-state restoration (7-5, 7-45). Reading that
sequence does **not** prove a universal post-fault RAM payload guarantee.
The local official PDF SHA-256 witnesses are:

```text
253666-093-sdm-vol-2a.pdf 87c5acb6f27e24d9d364841a0d2346c91a8482e36f403409954e2d2a8c817bac
253668-093-sdm-vol-3a.pdf 310c6a64513e8095abfc32b6a158539560f499d53444050343022f7dda240211
```

Pinned [QEMU's CALL emitter](https://github.com/qemu/qemu/blob/v11.1.0/target/i386/tcg/emit.c.inc)
and [push/RIP lowering](https://github.com/qemu/qemu/blob/v11.1.0/target/i386/tcg/translate.c)
explain why an emulator observation is not by itself architectural proof.
The next obligation is to determine the allowed payload effect of the original
instruction #GP under the declared machine contract, using independent
hardware/virtualization evidence. Do not reinterpret the TCG advanced frame
as a matching result, hide mixed WHPX outcomes or change the product to match
one convenient sample. The strict CALL fixture and product lowering are
unchanged; this general equivalence gate remains red.

Browser observation was denied by the browser URL policy this turn. Neither
retained Worker was reloaded or declared stopped. There is no new browser
boot/PID 1/shell acceptance, no guest opcode fallback, and no change to the
published native bundle or human UI.
