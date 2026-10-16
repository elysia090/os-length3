# Independent startup frontier and physical root-image supply — 2026-10-04

## Independent startup, not browser acceptance

The extended **Node** diagnostic started before this loader change ends normally
with [this unmodified receipt](2026-10-04-node-startup-vector-red.json). Its
`status: pass` certifies bounded observations, **not** Linux boot. It stops at
the explicit common compiler grammar refusal -102:

```asm
ffffffff81204da1: f3 0f 6f 07       movdqu (%rdi), %xmm0
ffffffff81204da5: f3 0f 6f 4f 10    movdqu 16(%rdi), %xmm1
```

160,120,102 source retirements / 86,094,605 admissions reach early Linux
initialization, with 6,399 console bytes including NETLINK registration.
Complete 14,622,864-byte decompression agrees with the independent gzip/page
oracle. No PID 1, release-root mount, shell, development command or browser
acceptance is established. Calibration-dependent counts are not a percentage.
Raw JSON SHA-256:
`b88baad7d2ae2a02d5d15bf59abbff2425b5e71fdb1c4e6c0f7ab0b49b437979`.

The run uses the preceding unchanged 60,998-byte VM / 437,635-byte compiler
from the [output witness](2026-10-04-compiler-output.md), independent hidden
segments SHA-256
`5ca3956ada5dc86ca360e7b44c87145c19e300de7f96bf998594da22be32473b`,
and the same shipped kernel SHA-256
`21771c757255406ce090faa6c5108b72618f794c8e46379a4a3d50dc21364e67`.
It is not an observation of either retained browser Worker. URL policy still
prevents reading those tabs; neither is restarted or patched.

Measured milliseconds: cold C compilation 145,648.6, host engine construction
373,836.8, C execution 84,410.3, supply 194.3, admission 20,914.7, total elapsed
769,716.7. Remaining time includes loop/observer/clock/transport overhead.
These are not isolated boot benchmarks. The bounded host cache retains 751
exact candidates / 261,930 bytes but constructs 14,528,050 modules and evicts
14,527,298. 17,067,330 cold attempts clear 6,020,226,154 module-prefix bytes
and 1,364,218,080 report bytes. Full-capacity poisoning removal has not removed
this repeated construction/compilation work. It remains a dominant cost, not
proof of minimal topology or work/span.

## Missing source boundary and derivation

Native full-system validation supplies the immutable SquashFS at physical
0x30000000, reserves it with `memmap=SIZE$ADDRESS`, and exposes it through
Linux `phram.phram=system,ADDRESS,SIZE`. The earlier C boot source map covers
ordinary RAM, kernel, initramfs, metadata and explicit ROM only. The image
coordinate is unassigned, not zero RAM. Fixing ISA alone would therefore not
supply the installed root/toolchain.

The new cold attachment retains only `(image_address, image_bytes)` — 16
bytes, no payload or filesystem tree. For page address A, base B and exact
length L, the source exists precisely when `A >= B && A-B < L`. Its object
offset is `A-B` and length is `min(4096,L-(A-B))`. Transport authenticates that
extent and zeroes only final-page padding. E820 reserves
`ceil(L/4096)*4096` bytes. Adjacent holes never become source RAM.

The scoped contract accepts a page-aligned base outside ordinary RAM, below
1 GiB, length 1..256 MiB and end at most 1 GiB. Rejected pre-projection
reattachment clears the previous image. C-Wasm seals the source map on its
first successful page/CPU/segment projection; active memory cannot rebind it.
Prepare/close revoke the plan.

The **backing object** is immutable; admitted pages are private writable RAM,
matching native generic-loader/phram behavior. Writes change resident RAM,
never source bytes. Linux controls the read-only SquashFS mount, OverlayFS
copy-up, permissions and VFS. The loader does not discard phram writes,
implement syscalls or restore initial bytes over dirty pages. Dirty-page
persistence, eviction/recovery and Linux mounting the image remain open.

## Checks and real C-Wasm MMU

`check-boot-image.mjs` makes the old VM red because the required image export
is absent. An unattached image coordinate also refuses without modifying
source/output. The corrected [real C-Wasm receipt](2026-10-04-node-boot-image.json)
uses the 89,878,528-byte same-bundle SquashFS, SHA-256
`6c7f0ea12300984eb1f9e9d4e33eef2be8db642e22afa9f776342a17a888bda9`.
66 source projections leave payload untouched. 278,528 bounded source bytes
are read; only two image pages are admitted by the actual C MMU/ticket owner.
Three C-generated identity page tables plus two image pages use 524,288 bytes
of Wasm memory. Duplicate/stale tickets, projection/open rebind, overflow,
holes, final page, E820 and unchanged complete CPU checks pass. Private writes
change RAM while rereading source proves backing bytes unchanged. This is
not a filesystem interpreter or boot test.

The native check classifies 100,000 independent extent pairs and the same
supply/write boundary. Full VM core `make check` passes on the independent
Linux build VM; scoped ASan/UBSan image checks pass. On Windows the existing
RTC libc oracle cannot represent year 9999 (253402300799 seconds). Its NULL
dereference stalled the diagnostic; NULL checks now produce an explicit red.
Those calendar cases are not skipped or called green. Product RTC is unchanged.

With no image attached, the new one-million-admission startup retains 32
architecture/source/trace/resource observations from the preceding output
witness. Image attachment extends the actual command. Its independent
86-instruction prefix remains, but the old 378-instruction parser count does
not certify this input. Incoming count 1,264 is explicitly recorded as an
observation, not an independent parser oracle. REP/BSS still check exact
+1/+13 transitions, complete CPU/caches, all 3,040,256 relocation bytes and
98,656 BSS bytes. The image-attached checkpoint retires 1,617,931 instructions
and ends at its quota, not Linux boot.

Fixture staging uses one 65,536-byte image payload buffer and 1,372 chunk
digests, not `readFile` of the full image. Image staging requires a fresh
explicit output and rejects an existing directory. A validated separate
fixture selector avoids replacing retained Worker inputs. Image kind 5 uses
the same bounded Range/digest reader with kind-isolated cache identity. This
local manifest is not signed production Artifact/Storage admission. Neither
the native release artifact nor human UI changes.

```text
new VM 61,482 bytes (+484); boot map +16 bytes, no payload copy
SHA256 26fd98da1ab163d5fb1f9d2230b47b15bdd3f3da78a3d2592be2e813bf5d010b
compiler unchanged 437,635 bytes
next ISA task: precise legacy 128-bit SIMD transfers, including MOVDQU
strict native CALL oracle red remains open; no expectation relaxed
```
