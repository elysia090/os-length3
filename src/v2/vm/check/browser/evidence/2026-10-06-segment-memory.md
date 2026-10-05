# Effective offsets and the unique hidden base — 2026-10-06

## The measured red

The completed unchanged-bundle run at `36eb952` passes MOVSB and refuses
`64 48 8b 04 25 00 00 00 00` (`mov rax, fs:[0]`) at
`0x7fdb6f31f16b`: compiler -102 after 186,388,534 retirements.
The console's `/init` announcement is not successful PID 1 execution.
See the [actual completed receipt](2026-10-06-node-startup-fs-red.json).

Running `check-segment-memory.mjs` with that frozen 452,030-byte compiler
(SHA-256 `9f499cdb551596413e13a1c0536ce3fee79e1650bda7406ebb69ad4f42f256c4`)
again fails the very first exact-source admission assertion: -102, expected 0.
This is a common address-grammar rejection, not a request to emulate guest
TLS or `arch_prctl` in JavaScript.

## Substitution, order and ownership

For an explicit memory operand with address width A in {32,64}:

    offset = truncate_A(base_register + index_register * scale + displacement)
    linear = offset + hidden_segment_base   (modulo 2^64)
    ordinary_linear_preflight(linear, extent, rights)

For IP-relative addressing the admitted fallthrough supplies the base
register term. FS/GS use the existing hidden cache; other accepted long-mode
data segments have zero bases. Truncating `linear` instead of `offset` loses
a high FS/GS base. Checking the offset for canonicality before adding the
base incorrectly rejects a wrapping offset whose final linear address is
canonical. The ordinary C MMU checks the final address/range and produces
the existing precise #GP/#PF frontier. LEA returns only `offset` and never
adds a segment base or calls the memory provider.

This order follows the
[Intel architectural manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
and the [Linux FS/GS contract](https://kernel.org/doc/html/v5.14/x86/x86_64/fsgs.html).
A null/unusable visible FS/GS selector does not suppress an independently
MSR-written hidden base in the accepted long-mode profile.

Memory ABI 2 adds two role bits, not another memory opcode or import type.
The common `vm_segment_address` substitutes the base once, strips the role
and feeds the existing linear boundary. Scalar access, RMW reservation,
pair/extent, ordered records and table transactions all use it. No base is
copied into Wasm code, source rows, bindings, descriptors or a host TLS map.
Fetch/implicit stack accesses remain separate; conflicting FS+GS, FS/GS with
STACK/fetch and unsupported CS/base contexts refuse before a payload access.
The compiler's report aggregates explicit and implicit roles for PUSH/POP;
that summary is not used as the flags of a single transaction.

All access constants use signed Wasm `i32.const` encoding. The old unsigned
writer encoded 64 as the signed byte `0x40` (-64); two-byte positive signed
encoding is required. Native/cold byte parity alone would miss this because
both compilers shared the bug. Actual generated execution exposed it.

A latched one-instruction page wait keeps the original C-owned row, slot and
binding. Interposed MSR operations, including SWAPGS, refuse before resetting
its supply ticket or reservation. A fresh instruction observes a newly
published base without retaining a duplicate base in its fetch context.
This is the serialized trusted-owner profile, not an SMP/shared-memory or
untrusted-host-write safety claim.

## Counted green, not Linux acceptance

[Measured receipt](2026-10-06-segment-memory-green.json):

* 24 fresh native C/cold-Wasm C byte-parity emissions.
* 640 successful and 384 faulting actual x86 observations: 24 forms of
  FS/GS load/store/ADD-memory/LEA/MOVSB/absolute TLS, both address widths;
  normal/high/zero bases, offset wrap, missing and crossing pages, final
  noncanonical address. The fault set is 256 #PF + 128 #GP.
* 1,024 direct and 1,024 C-dispatch comparisons against those observations:
  all GPRs/flags, complete 8 KiB payload, retirement and precise fault fields.
  Unobserved CPU fields and hidden caches are unchanged models. Linux's #GP
  `si_addr` is not asserted to equal the C MMU's linear diagnostic address.
* 240 metamorphic address comparisons across 20 memory families, two
  segments, two address widths and normal/fault/wait cases. SIMD, FX state,
  stack, branch targets, table operations, REP, CMOV/bit/shift/division use
  the same linear coordinate. These isolate address substitution; they do
  not independently prove those families' ISA semantics.
* 160 metamorphic C supply/latch waits and resumes; row mutation cannot
  replace the latched entry. Duplicate commits refuse. Two additional
  latched MSR-write refusals preserve the original ticket, followed by
  successful resume; two fresh-base publication models pass. Twelve
  invalid-role/profile refusals preserve state/cache/payload.

Native compiler/CLI `make check` and all native VM checks pass without new
warnings. Scoped GCC ASan/UBSan instruments the VM helper/library and the
compiler/code-cut admission check. Separately linked x86/optimized-x86/
support provider libraries are not claimed instrumented. The low/high fixed
mapping native observation fixture is not claimed ASan-instrumented.

Regressions: 1,248 direct + 1,248 dispatch native string comparisons and
24 waits; entry-binding models; direct CALL sharing; SYSCALL/SYSRET (752
direct + 752 dispatch, 232 recorded TCG differences not waived). REP fixtures
were freshly emitted by the current native C CLI, not executed from old
ABI fixtures: MOVS and STOS each retain 336 native CPU/RAM comparisons,
144 bounded resumes, 184 refusal cases, two source-code alias continuations
and 24 RF models; partial/fault/miss counts are 88 / 66.

Reproduce native observations with `make -C src/v2/wasm-compiler
segment-memory-check`, then `build/segment-memory-check NEW-DIRECTORY`.
Use `node data/oracle/check-segment-memory.mjs VM.WASM COMPILER.WASM
NEW-DIRECTORY` to check the freshly emitted receipts. This construction
runs actual x86 with a raw assembly base/restore envelope; no C/libc executes
with the substituted host FS base. Fault entry restores both bases first.

Frozen candidate VM/compiler are **70,499 / 452,168 bytes**, SHA-256
`0c3142f523b4713e5034772569a73f32d6abe71f73c23d6da9bc45319c7e950f` /
`aadc0992fcdaf1295e217ecbffd18550c6eb0d98410b3475dfca3d296e4d18c4`.
Entry ABI, source rows/report, native publication, UI and quotas are unchanged.
The independent same-bundle rerun uses warmCuts=64 and the original immutable
root/segment fixture. These tests do not replace retained browser Workers or
staged assets. PID 1, root mount, shell/tooling, cold shell 3s and real-browser
acceptance remain unachieved until separately measured.
