# x86 semantic oracles

`check-absent-io.mjs VM.WASM COMPILER.WASM` checks the fixed platform's eight
absent ISA-DMA page ports and three absent legacy UART ranges through actual
cold C emission and C table/MMU execution. It neither creates phantom devices
nor accepts arbitrary unknown I/O. The old DMA-only check was expanded and
renamed, not kept as a second implementation. See
[DMA contract](../../src/v2/vm/check/browser/evidence/2026-10-05-absent-dma.md) and
[serial absence](../../src/v2/vm/check/browser/evidence/2026-10-05-absent-serial.md).

`check-source-cohort.mjs VM.WASM COMPILER.WASM` proves source-owned warm
quanta through actual C-MMU/table execution and measures a paired fixed
65,536-retirement boundary workload. It tests partial prefixes, fault/remap/
write/shadow/context and later-cut console/growth continuation, not Linux
speedup. See [derivation and limits](../../src/v2/vm/check/browser/evidence/2026-10-05-source-cohort.md).

## C-Wasm browser boundary — 2026-10-02

`powershell -File data/oracle/wasm-tools.ps1` pins official wasi-sdk-34's
Windows archive by SHA-256 and extracts only Clang, wasm-ld and builtin headers
under repository `temp/`. It builds the freestanding C VM provider with one
import, `machine.memory`: no WASI guest libc, JS guest-memory callback, decoder
or distribution dependency. The pin is a build-tool version, not a claim that
its LLVM release-candidate compiler is a stable release.

```sh
make -C src/v2 all
bash data/oracle/check-wasm-cuts.sh temp/fresh-register-records
node data/oracle/check-wasm-cuts.mjs temp/fresh-register-records
bash data/oracle/check-wasm-memory.sh temp/fresh-memory-records
bash data/oracle/check-wasm-stack.sh temp/fresh-stack-records
node data/oracle/check-wasm-provider.mjs temp/wasm-tools-34/vm.wasm temp/fresh-memory-records
node data/oracle/check-wasm-provider.mjs temp/wasm-tools-34/vm.wasm temp/fresh-stack-records
```

Only source compilation/native observations run in the build guest; actual
Wasm comparisons run in Node or the browser. Output directories must be fresh.
No oracle is an alternate guest execution route. `prepare-browser-provider.mjs
VM.WASM NATIVE-MEMORY-RECORDS COLD-COMPILER.WASM` stages a small ignored diagnostic for
`vm/check/browser/provider.html`; the user-supplied 512-case real-browser receipt
is retained in that directory's `evidence/`. Diagnostic digests detect stale
fixtures; they are not a production release-root signature.

The compressed-kernel CPU check is independently reproducible:

```sh
make -C src/v2/x86 build/kernel-profile-check
sh data/oracle/check-kernel-profile.sh ACTUAL-KBUILD src/v2/x86/build/kernel-profile-check
```

It reads that build's generated `asm/cpufeaturemasks.h`, not an architecture-name
guess. The exact shipped 7.2.7 configuration exposed missing PAE/PGE in v1;
the v2 CPU contract passes. The required hardware masks do not certify every
advertised instruction or exactly masked native CPU execution.

After authenticated extraction of the **published** native bundle, reproduce
its bounded cold boot-state/page projection without reading the whole kernel:

```sh
make -C src/v2/vm build/boot-check
mkdir temp/fresh-boot-records
src/v2/vm/build/boot-check ROOT/boot/kernel ROOT/boot/initramfs temp/fresh-boot-records/shipped
node data/oracle/check-wasm-boot.mjs temp/wasm-tools-34/vm.wasm temp/fresh-boot-records/shipped
```

If the build guest and Node are separate, transfer only the small generated
records. The comparison covers C-generated boot parameters, GDT, initial
identity tables/state and a C-MMU fetch of the actual 64-bit entry, not kernel
instruction execution, CPU exception delivery, root-device publication or
Linux boot. Dirty/COW state is outside this initial-content projection and
must never be reconstructed as initial zero RAM after execution.

## Independent native oracles

### Coordinate binding and exact sharing — 2026-10-05

`check-cut-coordinate-sharing.mjs COMPILER.WASM` is an independent cold-C
emission test, not an ISA oracle or production route. It
checks complete coordinate-normalized state covariance and unchanged wrong-RIP
refusal, then requires a single exact topology per shape across twelve virtual
coordinates. The original compiler failed all ten families; ABI 2 now passes
their exact-template condition. `--observe` separates fresh/warmed Module
and Instance construction under
unchanged bounded-owner quotas. It never edits Wasm bytes or removes entry
checks. The original [red and factorization](../../src/v2/vm/check/browser/evidence/2026-10-05-coordinate-sharing.md)
remain historical evidence. `check-entry-binding.mjs VM.WASM COMPILER.WASM`
separately exercises shared templates through the actual C-MMU/typed table,
including literal preservation, relative/absolute targets, #DE/fetch faults,
REP descriptor mutation/growth and old-ABI type refusal. Its explicit models
do not replace independent native instruction observations or Linux boot.
Use fresh native-emitted fixtures with the current compiler: stored ABI-1
modules are not adapted into ABI-2 validation. See
[ABI-2 evidence](../../src/v2/vm/check/browser/evidence/2026-10-05-entry-binding.md).

### Serialized memory-order cuts — 2026-10-05

`src/v2/wasm-compiler/check/memory-order.c` records GPR/flags/FPU preservation
on native x86 before and after lowering, with `--observe` available before
compiler support. `check-memory-order.mjs VM.WASM COMPILER.WASM EMITTED-DIR
OBSERVED-DIR` requires byte-identical independent observations, exact cold-C
emission, real C-MMU/dispatcher execution, shared-Memory refusal and crossing
fetch/growth checks. Concurrent memory ordering is not inferred from a native
value-state fixture. See [the empty-frontier derivation](../../src/v2/vm/check/browser/evidence/2026-10-05-memory-order.md).

### Accelerator provenance and near CALL faults — 2026-10-04

Native user-mode fixtures run inside the independent build VM. They do not
imply a particular accelerator: on this Windows run the active process and
`temp/bootstrap/execution.json` both specify **WHPX**, with a start time of
2026-10-02 20:56:13 local. Earlier evidence prose/JSON calling that build VM
"TCG" is an attribution error, not a changed byte receipt. Explicit system
observers that launch `-accel tcg` remain TCG observations. Neither backend
is a product dependency, a universal hardware oracle or an equivalence proof
by itself. The [CALL evidence](../../src/v2/vm/check/browser/evidence/2026-10-04-call-fault.md)
records that distinction and retains the strict product red.

The standalone `call-fault-observe.c/.S` has no product/compiler dependency.
It separately counts stack payload and all-GPR/RSP/RIP/#GP frame outcomes:

```sh
bash data/oracle/prepare-call-fault.sh NEW-DIRECTORY
NEW-DIRECTORY/root/init 4096 > NEW-DIRECTORY/native.log
node data/oracle/observe-call-fault.mjs NEW-DIRECTORY/native.log
node data/oracle/observe-call-fault.mjs QEMU SHIPPED-KERNEL NEW-DIRECTORY/observer.cpio.gz NEW-TCG-LOG
```

The last invocation uses an isolated, networkless TCG diagnostic `/init`,
not the release root, a browser fallback or Linux product acceptance. A receipt
has `status: observed`, never `pass`: original-frame and advanced-frame outcomes
are not interchangeable expected states. Permission transitions occur before
each test, and all tested stack bytes are writable at the actual CALL. Fresh
outputs are required. The source and exact minimized full-fixture input are
retained, not hidden by retrying a red until green.

For an independent Windows-native observation, outside that build VM:

```sh
gcc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror data/oracle/call-fault-windows.c data/oracle/call-fault-windows.S -o NEW-DIRECTORY/call-fault-windows.exe
NEW-DIRECTORY/call-fault-windows.exe 4096 > NEW-DIRECTORY/windows.log
node data/oracle/observe-call-fault-windows.mjs NEW-DIRECTORY/windows.log
```

This uses Win32 vectored exception contexts, not a claimed architectural
exception vector or bare-metal CPU oracle. CPUID provenance is retained.
Recovery does not retry the faulting CALL. The parser requires all 216 groups
and their complete totals; mixed payloads remain observations, never an
equivalence pass. See [Windows evidence](../../src/v2/vm/check/browser/evidence/2026-10-05-call-fault-windows.md).

### Cold output witness without per-cut capacity poisoning

The startup diagnostic's `CompilerOutput` initializes its 64 KiB output and
80-byte report once. After success it poisons only the preceding declared
module prefix plus the fixed report. A refusal still compares **all** 64 KiB
and the report; an illegal write outside a successful declared prefix now
survives and is detected on refusal instead of being erased by full poisoning.
This is diagnostic host work, not a guest opcode, compiler shortcut or relaxed
ISA expectation. The C compiler, emitted bytes and execution quotas are unchanged.

```text
node data/oracle/check-compiler-output.mjs COMPILER.WASM
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM BOOT-FIXTURE-DIRECTORY
```

The component requires exact full-capacity/report parity on 513 real C emissions
and three refusals, including genuine one-page tail refusal -> two-page supply.
It separately exposes undeclared tail publication, partial refusal output,
invalid length, host-trap reuse, shared memory and invalid reservations.
The [fixed-work receipt](../../src/v2/vm/check/browser/evidence/2026-10-04-compiler-output.md)
counts initialization and steady-state stores separately. Reduced poison traffic
does not mean reduced artifact size, engine RSS, x86 work/span or cold-shell time.

### Address-only page invalidation

The common cold compiler lowers the already-typed INVLPG descriptor. The
current C MMU has no retained TLB or paging-structure cache, so invalidation
has no cache state to mutate; privilege, precise cut and retirement remain.
This relies on fresh translation at **every** payload access and compiled
entry fetch, including global/large pages. Introducing a retained translation
cache requires changing that compiler/MMU contract together. Source/module
caches are not translation caches. There is no kernel-coordinate opcode skip.

In the reference build guest (oracle/build only):

```sh
make -C src/v2/wasm-compiler build/invalidate-check
mkdir NEW-DIRECTORY
src/v2/wasm-compiler/build/invalidate-check NEW-DIRECTORY
bash data/oracle/prepare-invalidate.sh NEW-DIRECTORY
```

The last command observes all 84 exact source forms at real native CPL3 and
requires a precise #GP(0). The assembled system fixture observes the same
forms at QEMU TCG CPL0, including absent/noncanonical addresses, segment
prefixes and preserved flags. It is an independent system oracle, never a
product execution backend. After copying the fixtures to Windows:

```text
node data/oracle/check-invalidate-system.mjs QEMU SYSTEM.ELF FIXTURE-DIRECTORY NEW-LOG
node data/oracle/check-invalidate.mjs VM.WASM FIXTURE-DIRECTORY
```

The second command exercises the emitted cuts and actual C-Wasm MMU/dispatcher:
privilege/RF/AC/address/reservation cases, guest PTE remaps, A/D effects and
precise NX/non-present entry fetches despite a retained module. It is not a
native hardware TLB oracle, Linux boot or full exception-entry proof. General
large-page/global remaps and permission changes are also in `vm/check/mmu.c`.

The product does not contain QEMU, KVM, Remill or Intel XED. These pinned
upstreams are development inputs used to prove the standalone C post-link
compiler. They never become a runtime fallback, a delivery object or part of
the Linux machine identity.

Run `./fetch.sh` to place the verified source archives in `data/upstream/`.
The archives are ignored because `oracle/sources.env`, not an expanded checkout, is
the reproducible source lock.

`build-qemu.sh` incrementally builds only `qemu-system-x86_64` with TCG in a
stable `/tmp/libqm-x86-oracle` checkpoint (override with
`QM_ORACLE_BUILD_ROOT`). `boot-qemu.sh BZIMAGE INITRAMFS` then supplies the
independent expected boot/terminal behaviour. Neither command writes an
artifact. Windows-side validation uses the pinned portable QEMU documented in
`../bootstrap/README.md`, without NixOS or WSL. Building this separate TCG oracle
from source additionally requires glib and pixman development headers.

`build-boot-probe.sh STATIC-BUSYBOX OUTPUT.cpio.gz` builds an isolated initramfs
for separating a kernel/boot-wrapper defect from the complete release root.
`node check-native-boot.mjs QEMU KERNEL INITRAMFS OUTPUT-LOG` runs the pinned
external QEMU under TCG, with no default network device, and requires actual
serial shell commands to complete within 45 seconds. It refuses to overwrite
an earlier serial log. Use the same initramfs and CPU profile for linked and
optimized kernel comparisons. A pass is only a kernel/init/shell/exec probe;
it does not certify the distribution, service graph, toolchain, or boot speed.
Appending a `SYSTEM-SQUASHFS` argument selects the full offline system witness.
QEMU supplies that exact immutable image through the same reserved phram
coordinate as `boot-qemu.sh`; Linux owns the mount. The gate requires PID 1 to
be s6-svscan, the actual installed apk/account/service files, `s6-rc -a list`
containing interactive-ready with the network branch inactive, `s6-rc diff`,
then native C, `make -j4`, Git commit/history, AES/PBKDF2 encrypt/decrypt and
`apk info musl`. Service queries
follow the locked s6-rc 0.7.0.0 upstream's `doc/s6-rc.html`; presence of the
compiled database alone never counts as a running service graph. Any command
failure stops the independent guest shell and fails the witness. It also
modifies `/etc/hosts`, verifies the SquashFS lower file is unchanged, and
rejects materializing `/usr` in the tmpfs upper during the development witness.
Cold readiness is measured at the actual service transition's
`interactive-ready` marker, before paced UART command transmission.
The full mode remains a publication gate, not an isolated-shell release claim.

The C boot loader can now attach that same immutable source image before
projecting any pages/state: `vm_boot_image(address,bytes)`. It reserves the
rounded physical extent outside ordinary RAM and returns bounded image-kind
5 source coordinates through the existing page ticket. Admitted pages are
private writable RAM, not a second VFS or silently discarded phram writes;
Linux owns the read-only mount/OverlayFS. Test with:

```text
node data/oracle/check-boot-image.mjs VM.WASM SHIPPED-BZIMAGE SHIPPED-INITRAMFS SYSTEM-SQUASHFS
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM PREFIX-DIRECTORY --segments=INDEPENDENT-SEGMENTS --image=SYSTEM-SQUASHFS
```

`--extended --progress` adds a bounded longer independent Node diagnostic and
compact JSON progress on stderr; final JSON stays on stdout. This is not a
retained-browser observation. Duplicate/unknown/empty flags fail before I/O.
Always propagate the Node exit status when capturing its output through a
shell pipeline; a successful final pipe command does not certify the probe.

`prepare-browser-startup.mjs VM.WASM COMPILER.WASM PREFIX-DIRECTORY SEGMENTS
SYSTEM-SQUASHFS NEW-OUTPUT-DIRECTORY` stages the image with a bounded 64-KiB
hash buffer. Image staging refuses an existing destination and requires the
explicit new directory. A diagnostic folder named `generated-startup-NAME`
can later be selected with `startup.html?fixture=generated-startup-NAME`;
only those same-origin diagnostic names are accepted. Do not restage/reload a
retained running Worker. The local hash manifest is not production signed
admission, and page/extent checks never certify a Linux root mount or shell.
Current [evidence and remaining SIMD gate](../../src/v2/vm/check/browser/evidence/2026-10-04-boot-image.md)
distinguish independent Node receipts from browser acceptance.

Use a full candidate installed root to build that test image; the image is
oracle scratch, not a second published distribution or another execution route.
If the linked baseline is red too, first fix that baseline before attributing
the failure to post-link compilation.

The full-root baseline exposed two recipe defects before any optimization
claim: minimal BusyBox requires mount options before source/target operands,
and s6-supervise executes longrun `run` files directly rather than supplying a
shell fallback. The init archive follows that argument order, and
`../distribution/check-service-sources.sh` rejects missing shebangs and invalid
shell syntax before compiling the service database. Linked and optimized
kernel runs must use the same fixed full root; a diagnostic syscall helper or
an edited upper root never certifies the delivered boot path.

The console also keeps the session that s6-supervise already created. Starting
BusyBox setsid inside it forks and exits; the supervisor then repeatedly
restarts the service while orphan shells compete for UART input. The delivered
run script uses cttyhack directly, and the full witness checks that the live
supervised console PID executes BusyBox.

`check-kernel-zstd.sh KBUILD POSTLINK-COMPILER POSTLINK-VERIFY PAYLOAD` links
the actual kernel Zstd/xxhash objects into a normal userspace test ELF. It
compares inode/directory metadata and page-sized streaming decompression before
and after post-link compilation, byte for byte, with the original payload.
Malformed-frame and truncated-stream witnesses also require the same ordinary
error return, diagnostic and already-written prefix; a signal or false success
does not count as equivalent failure.
This caught a real verified-output fault after the uncompressed filesystem
readback was green: a nested MOVSXD/ADD publication had been scheduled after
the terminal CMP because each leaf preserved flags. The ADD did not. A general
native fixture and 1,310,720 source/all-candidates/reference observations now
check all Jcc conditions, signed/unsigned extensions and the full defined flag
word. Neither the fixture nor this object-level oracle replaces complete boot
with the entire optimized installed root.

Select the BusyBox binary by the current build's recipe/checkpoint identity,
not by the first match among cached input directories. The probe builder
checks shell arithmetic before creating its archive. The serial driver waits
for an actual shell prompt and paces UART input; writing an entire command
burst to a host pipe is not UART flow control and can lose characters.

The native boot probe stops on a kernel oops, panic or fatal FPU initialization
instead of waiting out nested faults. Native instruction regressions also
compare BSF/BSR zero-input destinations with the linked program on the same
CPU: the destination is a pass-through input, not a free value to erase.
The upper half of a zero-input 32-bit scan is CPU-dependent; this is also
documented by [LLVM's pass-through lowering change](https://lists.llvm.org/pipermail/llvm-commits/Week-of-Mon-20250120/1549120.html).

Runtime instruction-byte observations are distinct from execution roots.
A field-relative patch directory may point inside a MOV or shift instruction;
the compiler must retain its proved owner's spelling and field offset, not
decode the immediate as a new entry. Conversely a table-base-relative word in
mixed data is not a patch-directory row. Native fixtures check both sides of
this boundary, patch distinct wide constants and a narrow count, and execute
the results. Exception-table fixups and warning-trap continuations are external
machine control roots and have separate native fixtures. A real boot that
passed static proof still exposed a misplaced runtime write; external QEMU
watchpoints identified that first write, rather than guessing from the later
fault or using the kernel's unchanged source-coordinate symbol map.

## Roles

No one implementation is allowed to certify itself.

| source | role | deliberately not trusted for |
| --- | --- | --- |
| QEMU 11.1.0, x86 TCG system frontend | primary behavioural oracle for privilege checks, precise exceptions, control/descriptor/MSR state, page walks and interrupt entry; its typed TCG stream is also the structural comparison for block effects | product execution, product decoding, artifact publication |
| Remill 6.0.1 commit `0e324aee...` | independent Apache-2.0 instruction semantics lowered to LLVM IR, especially integer, x87, SSE, AVX and AVX-512 families | complete system-machine behaviour; many privileged effects intentionally become hypercalls |
| Intel XED 2026.07.15 | independent decode, operand, implicit-register, flag-action, ISA-set and CPUID boundary | instruction execution semantics |
| Berkeley SoftFloat 3e commit `a0c6494c...` | IEEE binary32/binary64 arithmetic, conversions, rounding and exception-flag oracle before applying x86 MXCSR DAZ/FTZ/mask rules | x86 NaN operand-selection, DAZ/FTZ, exception delivery or product execution |
| KVM on a pinned host CPU, when available | hardware differential samples for user and guest-ring tests | reproducibility across CPU models or the only exception oracle |

QEMU is GPL-2.0. Its source may be executed as an external test oracle, but no
QEMU object or copied implementation is linked into `libpostlink.a` or
`vm.wasm`. Remill is the reusable structural semantics source: its LLVM output
may be normalized by a build-side importer into the post-link compiler's
stable semantic grammar. The checked-in result must retain its Apache-2.0
notices. SoftFloat is a BSD-licensed external test oracle; product code does
not link it, so its global rounding and exception variables cannot become
hidden runtime state. LLVM, Remill and SoftFloat are not required when the C
compiler is distributed or run.

## One comparison boundary

Each oracle case has one canonical input and one canonical observation:

```text
input = (bytes, RIP, decode mode, CPU feature model, architectural state,
         sparse memory generation)

observation = (ordered reads/writes, committed state, next RIP,
               exception vector/error-code/CR2, machine event)
```

The observation ends at the first precise fault or externally visible machine
event. Host addresses, QEMU temporaries, LLVM values, decoder enum numbers and
delivery coordinates are forbidden from the comparison identity.

The C post-link compiler must produce the same observation from its physical
SSA and its emitted native x86. Work and span may be reduced only while
preserving equality at this boundary. A semantically closed block may retain
its exact source x86 when no better candidate is proved; a missing semantic
closure is a compiler error, never a runtime decoder or interpreter route.
Static format/proof verification alone does not certify the emitted machine
code's behaviour: the paired native and complete boot gates remain required.

Two complete-root failures make this distinction concrete. Installed s6-rc
overwrote its saved entry stack pointer while allocating a VLA; a general
entry-generation regression now rejects that physical schedule. Installed
curl then misrelocated a checked switch whose default arm has an unknown
indirect tail call. Its table-base encoding survives independently of the
strict control-domain proof: an encoding-only prefix cannot be used to prove
an exhaustive successor set. The small native switch formerly passed static
proof but looped; it now returns the linked program's result. A second variant
changes allocated table bytes while retaining stale RELA records, checking
that final linked values own both saved and executed targets.

A third real failure was OpenSSH Ed25519 key generation: backward byte probing
invented a CMP inside a CALL displacement and discarded the real bounded
dispatch table. Comparison collection now decodes forward from a proved
function boundary, retaining only real nearby instructions. Immediate,
displacement and arithmetic variants of `interior-compare-table.S` reproduce
the old failure without an OpenSSH-specific rule. Preflight and installed-root
acceptance now generate an Ed25519 key, derive its public key and read back its
fingerprint; matching `ssh -V` alone cannot satisfy that gate. The keys exist
only in test scratch. RSA verification must reject an altered message with its
normal error status, not merely any nonzero status such as a crash.

Real xz compression exposed a fourth failure: its range coder reads the same
field as `[base + 4*index + 48]` and `[base + 4*copy]`, where
`copy = index + 12`. Losing that effective-address equality omitted the
shared-base table and left stale code targets. The affine memory fixture checks
substitution, domination of the comparison by the definition, unchanged address
generations and absence of intervening writes. Pointer/index mutation, a memory
write and a bypassed definition reject the bound. Preflight pairs serial and
threaded compressed streams with upstream execution and decodes the original
input; runtime repeats both encoder modes on the installed root. A successful
`xz --version` or decompression-only test is not an encoder acceptance test.

`trace-native-fault.c` is a build-side ptrace oracle, never a product execution
route. Breakpoints, optional indirect-field inspection and watchpoints follow
the first divergent value/control cut. `s6-rc-graph-readback.c` tests the actual
official graph implementation and can load a real compiled database; it does
not replace running the installed CLI. `check-native-runtime.sh` now checks
that CLI against the packaged offline service database before compiling C.
`check-native-https.py` serves a local authenticated TLS fixture on the build
host; only the released clients execute inside the immutable candidate root.
An optional comparison curl may run first, but cannot skip the installed curl,
Git clone or C-build gates. A passing comparison client is not a release result.

Guard closure follows actual direct control edges, including outlined arms and
tail calls across symbol boundaries. A lexical walk limit is not a terminal:
exhausting the bounded proof workspace rejects the candidate. Native switch
fixtures pair a long tail-call return with unconditional and conditional
guard-bypass counterexamples. Real GCC code-generation parity checks both a
header-free function and the larger physical-SSA translation unit; successful
`gcc --version` is not evidence that the compiler can compile C.
The release gate compares the entire compiler C translation-unit population:
`physical.c` alone missed a flags live-in at a computed jump in GCC itself.
Construction-binding demands must join, not replace, the indirect edge's
architectural observation. The native indirect-flags fixture distinguishes the
same two flags generations without relying on GCC-specific addresses or names.
An actual GCC inline-decision mismatch exposed a second boundary: a preloaded
shift was emitted before SETcc consumed flags preserved by a preceding load.
The entry-flags native fixture covers multiple readers and signed conditions;
7,077,888 direct execution comparisons cover all SETcc conditions, 32/64-bit
shift trees, logical consumers, accumulator/extended destinations and masks
inside and outside the low/high bytes. They also reject byte-width OR substitutions
that preserve the value but change the full-width SF/ZF/PF. Smaller byte
overlays remain permitted only when those flags are overwritten before use.

## Route into the standalone compiler

### C-Wasm dispatch/startup checkpoint

The VM builder now exports its C function table and bounded `vm_run`, using
`machine/entry.h`'s uniform `(i32 state, i32 port) -> i64` compiled type. Private
C callback slots are excluded from the admitted guest directory. Raw boot/code
pages and optimized ELF segments feed the same cold C cut planner/emitter;
the former requires external source authentication/generation admission and
does not invent an ELF proof. No decoder is linked into execution.

```sh
make -C src/v2/wasm-compiler build/code-cut-check
# The page is from boot-check's exact shipped bzImage record, not Kbuild vmlinux.
src/v2/wasm-compiler/build/code-cut-check SHIPPED.kernel-page 0x1000200 NEW-CODE-PREFIX
node data/oracle/check-wasm-boot.mjs VM.WASM SHIPPED NEW-CODE-PREFIX
node data/oracle/check-wasm-dispatch.mjs VM.WASM PURE-NATIVE-RECORDS
node data/oracle/prepare-browser-provider.mjs VM.WASM NEW-MEMORY-RECORDS COLD-COMPILER.WASM
node data/oracle/check-provider-worker.mjs
```

The current startup check retires fourteen shipped source instructions in C
dispatch, then stops at the memory-ADD compile gate `0x1000232`. Cold-loader
records include `.segments` as well as `.state`; the frozen register cut alone
cannot represent hidden segment caches or MOV SS inhibition. Run
`check-wasm-segments.mjs VM.WASM NEW-CODE-PREFIX` for the generated selector
matrix against the actual C boundary. It is NOT a hardware fault-entry oracle
or Linux/browser boot. See vm/check/browser/evidence/2026-10-02-segments.md.
The last command adapts only diagnostic fixture delivery/self under Node;
it is NOT an actual browser Worker/consent observation. `provider.html` v3
constructs the cut using the cold C-Wasm compiler before C table dispatch;
the native prebuilt cut is only a byte-comparison oracle, never a fallback.
Preserve the user's earlier v1 browser receipt as-is.
All guest RAM mutations, including page-table A/D, revoke code admission:
physical code/table aliasing is legal. Disjoint write-set optimization, complete
source/CPU/load/generation attestation and exception/device boot remain open.

### Authenticated bundle and cold compiler construction

The latest [common indirect-JMP checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-indirect-jmp.md)
uses actual native x86 receipts and the C VM/MMU, not a JS memory callback:

```sh
make -C src/v2/wasm-compiler build/branch-check
mkdir NEW-BRANCH-DIRECTORY
src/v2/wasm-compiler/build/branch-check NEW-BRANCH-DIRECTORY
node data/oracle/check-branch.mjs VM.WASM COMPILER.WASM NEW-BRANCH-DIRECTORY
```

It checks all GPR targets and ordinary memory-address forms, precise target
faults, load-before-target fault ordering, and the pure-prefix boundary before
an unemitted indirect successor. Startup now reaches the relocated trampoline
and stops at REP STOSQ (391 retired instructions); this is not Linux boot.

Use `compile-native-bundle.sh BUNDLE.tar.zst TRUSTED-SHA256 NEW-DIRECTORY`
instead of selecting a kernel address/page by hand. It consumes the published
native bundle, extracts only the required manifest/boot/bin members, lets the
C loader derive the actual startup entry, and invokes the standalone C CLI.
The exact published archive generates 11 kernel modules/14 instructions and
two BusyBox modules/five instructions. Exit 3, `closed:false` and the retained
whole-image -104 diagnostic explicitly mean partial construction, not boot.
See [BROWSER.md](../../src/v2/docs/BROWSER.md#compile-directly-from-the-shipped-native-bundle).

Build the same C decoder/planner/emitter as freestanding Wasm:

```powershell
./data/oracle/wasm-tools.ps1 -Compiler -Output temp/cold/wasm-compiler.wasm
```

```sh
node data/oracle/check-cold-compiler.mjs COMPILER.WASM BUNDLE-OUTPUT SHIPPED-BUSYBOX.elf \
  PURE-NATIVE-RECORDS MEMORY-NATIVE-RECORDS STACK-NATIVE-RECORDS
```

The 400,394-byte build imports only ordinary `machine.memory`; no WASI,
allocator, JS decoder or runtime source fallback is linked. This cold compiler
has its own C static/stack memory; do not overlap it with the independently
linked VM. The check matches 130 modules byte-for-byte against native C
construction, and rejects offset/alias/capacity/options/reopen errors without
mutating caller-owned reservations. Rejection checks cover source/output/report
reservations, not the compiler's mutable private C stack scratch.
All-product native check and compiler ASan/UBSan pass; the exact bundle's
fourteen-instruction C-Wasm dispatcher check is also green. None establishes
the still-missing whole-image/system/exception/device closure or browser boot.

The intended construction is:

```text
Remill semantic bitcode --build-side importer--> canonical semantic recipes
                                                       |
linked x86 --C decode + recipe specialization--> physical SSA --> optimized x86 ELF
                                                       |
QEMU TCG + XED + optional KVM ---------------- differential proof
```

Only canonical recipes and the C specializer are product inputs. Complex
system effects whose state is intentionally outside the pure recipe remain
typed machine operations in the secondary VM projection; QEMU checks those
operations against the same cut. Device I/O, clock, entropy and physical-page
delivery are the only host events. `WRMSR`, `LGDT`, control-register moves,
`IRET`, `SYSCALL` and page faults are machine semantics, not host barriers.

The [current browser arithmetic/CPU-control checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-misc-arithmetic.md)
keeps independent reference scopes explicit. `prepare-msr.sh DIR misc` plus
`check-msr-misc-system.mjs` compares nine legal QEMU MISC_ENABLE rows. TCG's
unchanged CPUID after those writes does not prove the architectural Limit/XD
side effects; those have separate literal-contract tests. `extend-check` and
`divide-check` capture actual native register/flags/#DE observations before
testing cold lowering; `check-extend.mjs` and `check-divide.mjs` separately run
direct cuts and C table dispatch. `prepare-memory-bit-cuts.sh` plus
`check-wasm-provider.mjs` covers immediate memory BT/BTS/BTR/BTC CPU/RAM and
protection-fault results, not exception entry. None is a Linux/PID 1 boot gate.

The [memory-unary/source-tail checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-memory-unary-source-tail.md)
adds `prepare-memory-unary-cuts.sh NEW-DIRECTORY` (22 ordinary post-linked
INC/DEC/NEG/NOT forms). `check-wasm-provider.mjs VM.WASM NEW-DIRECTORY` compares
CPU/RAM, actual native faults and separately RF success/failure semantics.
The checkpoint then compiled/installed ten real
single/two-page cuts through C source ownership and C dispatch, checking
demand-only FETCH, non-contiguous physical pages, exact writes, pinned A-bit
aliases, NX/nonpresent/residency, remap and lifecycle rejection. It is a
boundary regression, not boot or a cryptographic compilation attestation.
Regenerate fixtures for current compiler/ABI bytes; a stale fixture rejection
must not be relabeled as a pass.

The [scalar memory exchange checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-memory-exchange.md)
adds `prepare-memory-exchange-cuts.sh NEW-DIRECTORY` (32 ordinary post-linked
CMPXCHG forms, LOCK/no-LOCK). At that checkpoint `check-source-admission.mjs VM.WASM
COMPILER.WASM` performed 14 real cold emissions, including four both-arm/LOCK
source-alias writes through C dispatch, and rejects shared-memory linking.
LOCK coverage assumes one serialized owner of ordinary memory, not SMP.

The [memory condition checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-memory-condition.md)
adds `prepare-memory-condition-cuts.sh NEW-DIRECTORY` (25 ordinary post-linked
SETcc forms). At that checkpoint the source-admission driver performed 16 actual cold
emissions, including both SETcc truth values and equal-byte source invalidation.
The prior ten/fourteen-operation receipts remain historical observations.

The [signed memory bit-string checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-memory-index.md)
adds `prepare-memory-index-cuts.sh NEW-DIRECTORY` (38 ordinary post-linked
BT/BTS/BTR/BTC forms). It covers signed register indexes, negative/word/page
crossings, all widths/address sizes and shared bit/SIB indexes through the
same C MMU. The current source-admission driver performs 20 real cold emissions,
including signed BT/BTS source owners reached from an unmapped original base
and equal-byte modification fences. Native fault and sanitizer scopes remain
explicit in the evidence; component green is not Linux boot.

The register summary oracle uses
`prepare-summary-cuts.sh NEW-DIRECTORY`, then `check-wasm-cuts.mjs NEW-DIRECTORY`
and `check-wasm-dispatch.mjs VM.WASM NEW-DIRECTORY`. The 75 fixtures cover
BSF/BSR, their fixed-profile F3 legacy forms and POPCNT, all three widths,
self/extended aliases and ZF consumers before later kills. The fixed CPU has
no BMI1/LZCNT; native post-link analysis retains its separate superset-CPU
contract through the same decoder implementation. All Wasm compilation passes
use the profile-bound view, not a post-decode opcode rename.

The test-only observer retains the immutable certified source for definedness
and the delivered source page. For prefixed legacy forms it executes a leading
NOP plus the unprefixed scan in its private native mapping, preserving next
coordinates. A TCG CPU may execute TZCNT despite clear BMI1 CPUID, and physical
host supersets can also do so: those results cannot attest the legacy encoding.
`nativeLegacyPrefixTwin` marks this distinct oracle scope. Zero-source scan
destinations and undefined flags are not asserted as defined hardware values;
the drivers separately test the chosen whole-parent destination representative.
No such rewrite, CPU feature change or interpreter exists in product execution.

The [common rotate checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-rotate.md)
uses `prepare-shift-cuts.sh NEW-DIRECTORY rotate`, followed by direct and C-table
`check-wasm-cuts.mjs` / `check-wasm-dispatch.mjs` comparison. 110 ordinary
post-linked forms cover all widths/count masks, narrow/high/extended aliases,
whole turns, preserved zero-count flags and interior consumers. The default
script still prepares the 156 SHL/SHR/SAR regressions. The observer distinguishes
masked flag count from modulo-width value rotation and excludes only undefined
multi-bit OF per input. Memory and through-carry forms remain explicit refusals.

The [visible-selector checkpoint](../../src/v2/vm/check/browser/evidence/2026-10-03-selector.md)
uses `prepare-selector-cuts.sh NEW-DIRECTORY`, then direct/C-dispatch register
and C-MMU memory comparisons on its two subdirectories. Test-only selector
capture binds native observations to the oracle's actual process state; product
code never reads those host values. Separate model checks vary guest selectors.
All six selector reads preserve flags; register destinations obey width/parent
rules and every memory-prefix form stores exactly two bytes. Protected splits
must not publish CPU or partial payload. TF remains refused; RF is accepted
and clears only after successful retirement, never during a pending fault.

### Physical ROM versus guest paging rights

`make -C src/v2/vm check` includes 12,000 arbitrary-payload ROM cases; the
direct-entry boot template covers every page in C0000..100000. Actual C-Wasm
checks use the same boot fixtures as the browser:

```sh
node data/oracle/check-rom.mjs VM.WASM BOOT-FIXTURE-DIRECTORY
node data/oracle/check-physical-source.mjs VM.WASM BOOT-FIXTURE-DIRECTORY
```

The second command still refuses A0000/BF000/out-of-RAM, never inventing a
page or guest fault. Firmware fill is an explicit platform policy, not inferred
from E820. For an independent actual ROM-bus oracle, in a new scratch directory:

```sh
as --32 data/oracle/rom-system.S -o SCRATCH/system.o
ld -m elf_i386 -T data/oracle/exception-entry.ld SCRATCH/system.o -o SCRATCH/system.elf
node data/oracle/check-rom-system.mjs QEMU SCRATCH/system.elf SCRATCH/new-system.log
src/v2/vm/build/rom-check SCRATCH/new-system.log
```

The pinned official QEMU from the existing oracle recipe is used only for
reference. The last command compares its 17 observed arbitrary ROM words
against C-MMU writes and reservations. Repeat with the ASan/UBSan C binary.
These are bus transfer checks, not full instruction flags/exception proof or
Linux boot. [Derivation and limitations](../../src/v2/vm/check/browser/evidence/2026-10-03-rom.md)
record the actual browser's next memory POP refusal.

### Ordered POP stack read and memory destination

In a fresh scratch directory, with the built native C compiler:

```sh
make -C src/v2/wasm-compiler build/pop-memory-check
mkdir SCRATCH
src/v2/wasm-compiler/build/pop-memory-check SCRATCH
node data/oracle/check-pop-memory.mjs VM.WASM COMPILER.WASM SCRATCH
node data/oracle/check-source-admission.mjs VM.WASM COMPILER.WASM
```

`pop-memory-check SCRATCH --observe` obtains native-only receipts before lowering exists.
The new test is also part of normal `make check`. Native and actual C-MMU
checks compare the post-increment destination, separate 64-bit stack address,
fault priority, complete CPU/payload, retries and RF. The high test stack is
in a mapping disjoint from ASan's shadow; sanitizer coverage is explicitly
scoped in [the evidence](../../src/v2/vm/check/browser/evidence/2026-10-03-pop-memory.md).
Regenerate CALL receipts with the current `call-check NEW-DIRECTORY` before
running `check-call.mjs`: old emitted modules predate successful RF clearing.
The fresh driver compares both fault-time preservation and successful clearing,
never unconditionally refuses RF. None of these component passes is Linux boot.

This division avoids rebuilding QEMU while preserving the final route:

```text
linked x86 -> C postlink compiler -> ordinary optimized x86 ELF
                                          |
                                          +-> native execution
                                          |
                                          +-> Wasm projection -> vm.wasm
```

### C-owned RTC and sampled-clock continuation

```sh
make -C src/v2/vm check
node data/oracle/check-rtc-qtest.mjs QEMU-SYSTEM-X86_64 src/v2/vm/build/rtc-check
node data/oracle/check-rtc-provider.mjs VM.WASM COMPILER.WASM
```

The independent Qtest comparison pauses the oracle CPU and freezes its VM
clock: it checks indexed registers, NVRAM, BCD/binary and 12/24-hour fields,
SET, century alias and read-only/read-clear registers, not dynamic IRQ timing.
`rtc-check` separately compares a Gregorian era with libc and the bounded
next-alarm expression with a brute-force specification. Neither libc nor
QEMU is linked into the product. `qtest-device.mjs` is a test-only socket owner.

The compiled-provider test includes full CPU/segment observations, privilege
faults, sampled-clock ownership, duplicate/stale/cancelled replies and fresh
machine re-seeding. An already-started sampled instruction finishes before
the newly pending interrupt boundary. Complete frame/inhibition/priority
tests use the separate interrupt provider below.
Supervisor-only `vm_rtc_start` binds one explicit UTC epoch
to the current memory record/generation before RTC I/O or time advance. Guest code imports
only `machine.io`; C owns CMOS state and IRQ8, not a JavaScript port model.
The default browser diagnostic records its host UTC snapshot and advances
devices by active C execution time, excluding delivery/compilation pauses.
This is not authenticated UTC, wall-clock fidelity, a calibrated CPU, hardware
silicon equivalence, CPU IRQ delivery or a completed Linux boot.

### C IF/shadow and independent PIC interrupt entry

`interrupt-check` is the native IF/IOPL/shadow specification matrix, not a
privileged hardware oracle. `prepare-interrupt.sh OUTPUT` builds an independent
Multiboot PIT/PIC/IDT fixture. Its debugcon output has 192 records, including
consecutive STI/MOV-SS inhibition positions, gate types and stack alignment.
QEMU is only the test oracle, never the product guest execution provider.
Run `check-interrupt-provider.mjs VM.WASM COMPILER.WASM ROWS.txt` to compare
generated C-Wasm transfers and C PIC/IDT/IRET entry. Installed QEMU 11.1.0
sets saved RF for ordinary vector-32 IRQs; that one discrepancy is explicitly
excluded against Intel's boundary rule, with RF=0/1 separately modeled.
See [the exact scope and browser receipt](../../src/v2/vm/check/browser/evidence/2026-10-04-interrupt.md).
No IRQ frame test, including this one, establishes Linux/PID 1 acceptance.

### Shared memory shift/rotate SSA

```sh
make -C src/v2/wasm-compiler memory-shift-check
mkdir NEW-DIRECTORY
src/v2/wasm-compiler/build/memory-shift-check NEW-DIRECTORY
node data/oracle/check-memory-shift.mjs VM.WASM COMPILER.WASM NEW-DIRECTORY
```

Before lowering, `memory-shift-check NEW-DIRECTORY --observe` executes only
independent native x86 observations. SHL/SHR/SAR/ROL/ROR share register SSA
with memory reserve/commit: no operation callback crosses the C MMU boundary.
All four operand widths, CL/one/immediate counts, count masks, old-register
address aliases, 32/64-bit addresses, SS, RIP-relative writes, protection and
split faults are compared. A masked-zero count is not permission to skip
the memory transaction. Defined flags match the oracle; undefined AF/CF/OF
have the compiler's explicit zero representative. Separate serialized models
cover physical-row waits/retries, RF, stale/private ports and executable
writes. This is not a signed production page-supply or Linux boot test.
RCL/RCR, LOCK and FS/GS remain explicit compiler refusals with no output
publication. Pure predecessors end before the memory boundary.

### Shared double-shift SSA

```sh
make -C src/v2/wasm-compiler double-shift-check
mkdir NEW-DIRECTORY
src/v2/wasm-compiler/build/double-shift-check NEW-DIRECTORY
node data/oracle/check-double-shift.mjs VM.WASM COMPILER.WASM NEW-DIRECTORY
# Independent observations without invoking the lowering:
src/v2/wasm-compiler/build/double-shift-check OTHER-NEW-DIRECTORY --observe
node data/oracle/check-double-shift.mjs VM.WASM COMPILER.WASM NEW-DIRECTORY OTHER-NEW-DIRECTORY
```

SHLD/SHRD admit 16/32/64-bit register and memory destinations, GPR source and
CL/immediate count. The three old inputs are captured before a publication;
memory alone introduces C reserve/commit. All CL values, width/count edges,
source/destination/count aliases, flag predecessors and consumers, old RSP,
address-size truncation, scaled addressing, RIP writes and precise memory
faults are observed independently. Count zero still checks write permission.
For a 16-bit masked count greater than 16, only the low destination and
arithmetic flags are undefined; high parents, every other register, fault
ordering and memory footprint remain observed. The compiler's separate zero
representative is enforced, not attributed to hardware. A zero count preserves
predecessor flags. LOCK/FS/GS are refused before output publication.
The C-Wasm comparison checks direct execution, C table dispatch, RF,
serialized physical-row waits/retries and executable-write revocation. It is
not an exception-entry, SMP, signed page-supply or Linux boot proof.

### Bounded C source demand lifetime

`make -C src/v2/vm check` covers the serialized C source owner as well as
its MMU/write boundary. The fixed 64-rank demand list refreshes only after
complete executable admission: a failed tail does not refresh a crossing
row. Source writes still revoke exact extents and cancel pending whole-page
pins. Free ranks precede an oldest-demand replacement. The independent test
uses scan/timestamps; production uses only byte-sized rank links, not epochs
or a growing history. Run `check-source-admission.mjs VM.WASM COMPILER.WASM`
for actual C-Wasm compilation/table execution: 512 cold NOPs and 512 hot
CLC executions compare complete CPU state at unchanged slot quota, alongside
the existing source-write/alias/fault/grow/rebind matrix. These tests do not
measure browser speedup, signed supply or Linux boot.

### Common MXCSR transfers

```sh
make -C src/v2/wasm-compiler mxcsr-check
mkdir NEW-DIRECTORY
src/v2/wasm-compiler/build/mxcsr-check NEW-DIRECTORY
node data/oracle/check-mxcsr.mjs VM.WASM COMPILER.WASM NEW-DIRECTORY
# Run before implementation to separate observations from the compiler:
src/v2/wasm-compiler/build/mxcsr-check OTHER-NEW-DIRECTORY --observe
node data/oracle/check-mxcsr.mjs VM.WASM COMPILER.WASM NEW-DIRECTORY OTHER-NEW-DIRECTORY
```

LDMXCSR/STMXCSR share one exact four-byte C MMU transfer boundary and common
generated code. Native records observe MXCSR, GPRs, flags, whole neighboring
payload and actual operand/invalid-value fault frames. They cover every
reserved bit and both sides of crossing-page permission checks. Cold-C
emission is compared byte-for-byte before actual C table execution. CR0/CR4
priority, residency waits, RF and poisoned unrelated-state preservation are
explicit models, not physical-CPU or complete SIMD arithmetic observations.
Existing AC/TF and FS/GS admission refusals remain explicit, with no silent
successful retirement. See [MXCSR evidence](../../src/v2/vm/check/browser/evidence/2026-10-04-mxcsr.md).

### Bounded host construction and numeric trace

`node data/oracle/check-compiled-modules.mjs` checks exact-byte engine reuse,
unchanged quotas/import lifetime, inline tiny construction and cancellation
before any engine construction. Only the <=64 KiB emitted-body owner is
synchronous inside the execution Worker; large initial loaders remain async.
`check-mxcsr.mjs` also uses this owner for the unchanged native/fault matrix.

Run `node data/oracle/check-engine-construction.mjs COMPILER.wasm`, or open
`src/v2/vm/check/browser/engine-construction.html` with the existing authenticated
diagnostic compiler manifest. This compares 768 actual cold-C emissions with
rotating fresh-first method order and 2,304 whole-CPU preservation models.
All positions are reported; this is not an ISA oracle, timing CI gate, or
Linux/shell speedup claim. `node data/oracle/check-cut-trace.mjs` compares the
fixed 1,088-byte numeric observer with an independent eager-object reference.
Its 32-bit retirement count preserves a 65,536-instruction warm quantum;
invalid counts refuse before history mutation. `check-cut-progress.mjs`
checks bounded committed-prefix accounting against architectural retirement.
`check-source-cohort.mjs VM.WASM COMPILER.WASM` additionally checks that
accounting through actual C-selected cuts, later faults, console waits and
all 64 demand bits. `check-wasm-startup.mjs` accepts `--warm-cuts=1..64`;
only independently verified decompression and the Linux-entry witness enable
warm execution. Preproof cuts remain single and all cache quotas stay fixed.
No formatted history is materialized per cut. See
[measurements and scope](../../src/v2/vm/check/browser/evidence/2026-10-04-engine-construction.md).
