# Fixed CPU projection and stack flags — 2026-10-03

The exact published bundle now retires **378** startup instructions in an
actual ordinary-memory browser Worker. This extends the historical
[351-instruction receipt](2026-10-03-conditions.md); it does not rewrite it.
Linux boot/PID 1, shell/development, storage/network acceptance and the
three-second cold shell target remain RED. No native bundle or human UI change.

## Common cold lowering

CPUID becomes a serializing one-instruction cut with the fixed
`development-standard-v2` table compiled as ordinary Wasm constants. Its only
import is `machine.memory`: no host CPUID or operation callback. EAX is
captured before any output, all four outputs are zero-extended, and flags and
other registers are preserved. Unlisted rows return zero. Non-structured
leaves ignore ECX; structured leaf 7 is currently all zero, so its subleaf
input disappears. An independent literal table tests 67 leaf values, seven
subleaves, all CPLs and upper-parent variations: **7,504** complete CPU
comparisons through direct Wasm and actual C table/MMU dispatch. **15,008**
TF/RF entry refusals leave CPU state unchanged. This is a fixed contract
oracle, not host/hardware CPUID passthrough or complete ISA coverage.

POPF uses a privilege-dependent mask M derived from SDM Table 4-16:

```
M_base = CF | PF | AF | ZF | SF | TF | DF | OF | NT
M_64   = M_base | AC | ID
M      = (width == 64 ? M_64 : M_base)
         | (CPL == 0 ? IOPL | IF : CPL <= old_IOPL ? IF : 0)
flags' = (flags & ~(M | RF)) | (stack_value & M)
```

IOPL is writable only at CPL 0. IF uses the incoming IOPL, not a requested
replacement. Reserved bits, VM, VIF and VIP are unchanged; RF clears. The
16-bit form cannot change AC/ID. PUSHF removes VM/RF from the stack image.
Both widths use the existing C MMU stack read/write boundary and exact RSP
increment/decrement. Architectural writeback happens only after a successful
transfer. A preceding pure slice retires separately; a fault cannot discard
it or partially update the flags transfer.

Four flag-transfer forms were first RED in the C emitter. They now pass
**8,192** all-CPL/IOPL complete CPU/RAM comparisons (direct and C dispatch),
including cross-page transfers and arbitrary requested flag images. A small
assembly observer separately runs genuine PUSHF/POPF at CPL 3: **2,048**
hardware records produce **4,096** compiled pop/push comparisons. The observer
restores host flags and never enables TF/AC/NT in the host process. Those
privileged/trap cases are model tests, not a hardware exception-entry claim.
**36** noncanonical-stack/#SS, missing PTE/#PF, physical-miss, stale, entry
TF/RF/AC and private-port alias/wrap cases preserve CPU and payload on refusal.
Incoming AC/TF/RF contexts remain explicit admission refusals; alignment/debug
event delivery is not implemented by these tests.

## Actual shipped startup observation

The C-MMU page view follows actual RIP, with one reused table slot and no
manual branch-entry list or precompiled browser prefixes. The independent
1,256-byte CPU / 136-byte hidden-cache observation at instruction 86 remains
green. The no-LA57 CPUID path returns to the real caller. POPFQ consumes the
pushed zero; subsequent LEAs/count/STD produce the independently derived
relocation inputs at instruction 378:

```
RIP    0x1000281       next instruction: f3 48 a5 (REP MOVSQ)
CR4    0x20           PAE, no LA57
RSP    0x1e2c400      flags image popped
RFLAGS 0x402          fixed bit 1, DF set
RSI    0x12e63f8      final source quadword
RDI    0x1e283f8      final relocated destination quadword
RCX    0x5cc80        0x2e6400 bytes / 8
```

The compiler refuses the next coordinate with -102, without publishing any
output. No instruction is skipped or interpreted. The next common boundary
must preserve completed REP elements across faults, leave the faulting element
uncommitted, retain RIP/count until completion, and supply only necessary
source/destination pages. A single retirement counter is not a proof of this.

## Build identities and measurements

* Native bundle unchanged: **63,219,311 bytes**, SHA-256
  `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
* C VM unchanged: **16,745 bytes**, SHA-256
  `c3f2f5c6057048610b6eadefd2b55757c819a08a5e9ebed5f617d83850536d54`.
* Cold C compiler: **407,876 bytes**, SHA-256
  `1307e084cb78addeb12b64a5530b590b5d39fcdb9596c00d369a22c5a67b3bad`.
* [Actual browser JSON](2026-10-03-startup-cpu-stack-flags.json): **188**
  admissions, one live slot, zero manual branch entries. Total emitted bytes
  59,913, copied code bytes 774,144; VM memory 524,288 and cold memory 1,048,576.
  These are diagnostic bounds, not Linux RSS or a reclamation measurement.
* One browser sample: cold C calls 7.6 ms, engine construction 19.8 ms,
  C execution 2.6 ms. Excludes fetch/Worker/startup; not cold shell timing or
  a controlled performance comparison. Cuts are still recompiled on demand.
* **601** fresh native/cold byte-identical emissions, including repeats;
  existing 198 modules / 101,376 SETcc comparisons and 20 C code-view cases
  remain green. Full `make -C src/v2 -j2 check` and fresh compiler
  ASan/UBSan admission/code/fetch checks pass without warnings or sanitizer
  diagnostics. Provider bytes are unchanged; no new VM sanitizer claim.

```sh
make -C src/v2 -j2 check
mkdir temp/new-flags
src/v2/wasm-compiler/build/code-cut-check temp/new-flags
src/v2/wasm-compiler/build/flags-check temp/new-flags/native.bin
node data/oracle/check-cpuid.mjs VM.WASM temp/new-flags
node data/oracle/check-stack-flags.mjs VM.WASM temp/new-flags
bash data/oracle/prepare-startup-cuts.sh BUNDLE.tar.zst \
  4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc temp/new-startup
node data/oracle/check-cold-compiler.mjs COMPILER.WASM temp/new-startup BUSYBOX.elf temp/new-flags
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/prepare-browser-startup.mjs VM.WASM COMPILER.WASM temp/new-startup
node data/oracle/serve-browser.mjs --port=8080
# Open /src/v2/vm/check/browser/startup.html through standard browser control.
```

Source fixtures are authenticated from the unchanged bundle during preparation.
The local fixture manifest is not production signed code admission. Crossing
first-instruction fetch, general page supply, exceptions/MSR/devices/root and
whole-image closure (-104) are still missing. Do not substitute this diagnostic
pass, native QEMU boot, or the CPUID feature table for Linux browser acceptance.

Reference: [Intel SDM Volume 2B](https://cdrdv2-public.intel.com/868141/253667-089-sdm-vol-2b.pdf),
POPF pages 4-398–4-401 / Table 4-16 and PUSHF pages 4-519 onward.
