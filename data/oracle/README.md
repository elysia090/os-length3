# x86 semantic oracles

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

This division avoids rebuilding QEMU while preserving the final route:

```text
linked x86 -> C postlink compiler -> ordinary optimized x86 ELF
                                          |
                                          +-> native execution
                                          |
                                          +-> Wasm projection -> vm.wasm
```
