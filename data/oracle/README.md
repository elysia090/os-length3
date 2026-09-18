# x86 semantic oracles

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
SSA. QM may reduce work and span only after equality at this boundary is
established. An unsupported valid instruction is a compiler error. It is never
published as a generic barrier and never enters an interpreter.

## Route into the standalone compiler

The intended construction is:

```text
Remill semantic bitcode --build-side importer--> canonical semantic recipes
                                                       |
linked x86 --C decode + recipe specialization--> physical SSA --QM--> Wasm
                                                       |
QEMU TCG + XED + optional KVM ---------------- differential proof
```

Only canonical recipes and the C specializer are product inputs. Complex
system effects whose state is intentionally outside the pure recipe remain
typed machine operations implemented once in `vm.wasm`; QEMU proves those
operations against the same cut. Device I/O, clock, entropy and physical-page
delivery are the only host events. `WRMSR`, `LGDT`, control-register moves,
`IRET`, `SYSCALL` and page faults are machine semantics, not host barriers.

This division avoids rebuilding QEMU while preserving the final route:

```text
linked x86 -> C postlink compiler -> direct Wasm -> vm.wasm
```
