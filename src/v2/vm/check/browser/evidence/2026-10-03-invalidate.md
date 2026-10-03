# Address-only invalidation and the next machine boundary — 2026-10-03

The same published native bundle is unchanged. Its old cold-compiler refusal
at `0xffffffff8104a503`, `0f 01 3f` (INVLPG [rdi]), now executes through the
general typed compiler. This is not Linux/PID 1/shell success.

## Derivation before elimination

The [Intel INVLPG specification](https://cdrdv2-public.intel.com/774492/325383-sdm-vol-2abcd.pdf)
requires CPL0, preserves flags and invalidates translations, not the operand's
payload. A noncanonical long-mode address performs no invalidation. An absent
payload page must not cause #PF; invalid register/LOCK encodings are not this
instruction. Global/large-page invalidation is part of its architectural effect.
The [paging-cache invalidation rules](https://cdrdv2-public.intel.com/874249/253668-090-sdm-vol-3a.pdf)
also cover paging-structure caches. PCID is not exposed in the current profile.

Let `T` be retained TLB entries and `W` retained paging-structure entries.
The current machine has `T = W = empty`:

- `vm_mmu_access`, reservations and borrowed code pages use current guest PTEs;
  the resident physical index is not a virtual translation table.
- Every ordinary compiled cut fetches again through the C MMU, including a
  retained source/module handle. A/D writes revoke admission before mutation.
- Source/engine identities describe physical byte extents and compiled code,
  not a retained virtual-to-physical mapping or permission decision.

Therefore invalidation projects to the identity on **cache state**, not on the
whole architectural instruction. Its remaining transfer is:

```text
CPL != 0: #GP(0), unchanged CPU/RIP/RF/retirement; pending fault port only
CPL == 0: unchanged CPU/payload, RIP := fallthrough, retired := retired + 1
          RF cleared by the ordinary successful-retirement path
```

The effective address has no remaining consumer and is eliminated. One typed
system cut remains, importing memory only, with no guest-memory callback,
payload read, duplicate cache/dictionary, kernel coordinate or opcode skip.
FS/GS/SS/SIB/address32/RIP operands have the same empty-set effect. Common
privilege checking is factored with control-register reads; their old output
bytes and model regressions stay unchanged. TF/VM and invalid reservations
refuse before publication. Introducing a retained TLB/walk cache requires
changing this compiler/MMU contract together, not retaining this lowering.
This is a backend-specific derivation, not a global minimum-work theorem.

## Red then verified

- 84 source-address entrances were all red before implementation, then green;
  precise pure-prefix separation and LOCK/non-INVLPG refusals are also checked.
- 11,424 direct address/privilege/RF/AC/reservation model cases compare complete
  CPU and port bytes. This is not a native privilege oracle.
- The exact same 84 source forms produce 84 precise native CPL3 #GP(0) frames.
  QEMU TCG CPL0 produces 1,008 actual address/flag observations matching emitted
  Wasm, including unmapped and noncanonical addresses. This is an independent
  system oracle, not physical hardware, retained-TLB completeness or a backend.
- Actual C-Wasm MMU/dispatch passes 66 remap/A-D/NX/non-present-fetch cases.
  Retaining the compiled function cannot bypass the next fetch's permissions.
  Native C MMU adds 256 alternating 2 MiB remap rounds, all PGE/global settings,
  and read/write/execute/non-present checks; old 49,152 permission cases pass.
- Full `make -C src/v2 -j2 check` and all C VM core ASan/UBSan checks pass.
  Selected compiler/lowering ASan/UBSan checks pass; linked decoder/support
  archives in that run are normal builds, not whole-TCB sanitizer coverage.
- 777 native/cold byte-identical emissions, 5,280 previous control-read model
  cases and all 20 actual C source-admission regressions pass.

Reproduce exact emitted source/oracle fixtures using
[the oracle instructions](../../../../../../data/oracle/README.md#address-only-page-invalidation).
No native source/package/CPU-profile or human UI is changed.

Compiler: 420,876 bytes, SHA-256
`e1dfce6f0ecc667061061e47f890bc23996f1539c5efb84cac3648f99452ac00`.
VM: 31,653 bytes, SHA-256
`22626e16be0b3b84064d17837ec3a2ac73a625383caef50ebc41bf7de7864bb2`.
The VM's only execution change here is explicit boot-source-map refusal below;
its INVLPG semantics already follows from the tested uncached translation owner.
Native bundle: 63,219,311 bytes, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

## Actual browser and the next red

[The actual bounded browser receipt](2026-10-03-invalidate-browser.json) reaches
130,173,378 retirements / 64,985,059 admissions, 809 additional retirements past
the old INVLPG stop. Eight #PFs and six #GPs enter Linux's own handlers. Complete
decompression remains 14,622,864 bytes / 3,571 pages with the independent digest
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
Counts are not boot percentages. `linuxBoot=not-achieved`; no PID 1 or shell.

The next boundary is **machine physical-source supply**, not an unimplemented
opcode: RIP `0xffffffff812357cb`, physical read `0xf0000`, four bytes, access 17
(READ | PHYSICAL_REQUEST), current virtual source `0xffffffffff200000`.
CR3 is `0x1b1d000`. The native VM boot source map excludes the legacy reserved
`0xa0000..0x100000` area rather than treating it as RAM.

The first run threw a generic -1 and discarded the state. A second run
[preserves the bounded failure context](2026-10-03-invalidate-source-failure.json).
The new supply API separates invalid/stale input (-1) from a valid physical
request outside the source map (-4), without publishing a page, bytes, ticket
or invented #PF. Its witness was red before the change. Actual C-Wasm covers
36 read/write/RMW/width cases at reserved/out-of-RAM coordinates. The final
browser run reports the explicit `physical-source` gate at the identical state.
Diagnostic `status=pass` means the bounded invariants passed, **not boot**.

The locked Linux source independently corroborates a necessary firmware scan:
`drivers/firmware/dmi_scan.c:18` sets `SMBIOS_ENTRY_POINT_SCAN_START=0xF0000`,
and its non-EFI path (lines 726 onward) reads 64 KiB using `memcpy_fromio` before
rejecting absent/invalid signatures. This does not by itself identify the exact
optimized instruction's caller; the old linked System.map is not the shipped
optimized ELF's address authority. Do not relabel that old coordinate map.
The [Linux boot protocol](https://docs.kernel.org/arch/x86/boot.html) describes
loader/firmware bindings separately from the kernel and its RAM map.

Next: define the same machine's immutable firmware/reserved/device resources,
their physical coordinates and write/access/lifetime policy, then supply them
through C-owned physical access. Derive any absent-device/ROM value from that
explicit contract and test it independently; do not fabricate zero RAM, patch
the guest, skip DMI/ACPI or smuggle a QEMU/Python/JS backend into execution.
Linux remains the authority for interpreting any guest firmware tables.

Source reuse remains bounded: 64 rows, 6,752 metadata bytes, zero source payload
copies, 64,395,389 hits / 589,670 misses. Engine retains 64 instances / 20,878
module bytes. 200,950,255 emitted / 2,415,525,888 copied source bytes are cumulative
work, not RSS or delivery. 3,681 supplies / 3,694 resident pages; VM/cold memories
remain 15,728,640 / 1,048,576 bytes. Object transport remains 49 ranges /
3,154,432 fetched / 3,046,912 requested bytes / 65,536-byte cache high-water;
diagnostic module/hash requests are excluded. These local diagnostic hashes
are not signed-root/AEAD/ECC production admission.

Engine/execution/admission/cold buckets are 52,435.3 / 31,719.9 / 20,423.7 /
9,012.7 ms, not a controlled benchmark or cold-ready time. Cold shell 3 seconds,
the full development tools, workspace authentication/recovery and granted
network/service goals are still red; the goal remains active.
