# Bounded source demand lifetime — 2026-10-04

## Red and physical correction

The previous C source owner replaces its next rank on every miss, without
refreshing a still-valid demand. A source used between every cold insertion
therefore loses its compiled table slot after 64 misses, despite continuous
demand. The new native red records 64 unnecessary hot recompilations among
4,096 cold demands. The same red independently fails the old C-Wasm provider
after real compilation and execution; this is not only a host cache model.

The source owner still has 64 rows, one exact valid mask, fixed physical-write
watch/coordinate lookup buckets, and no copied source payload. Let L be the
ordered ranks of valid rows, oldest first. Its transitions are:

```text
complete hit(r):  L := (L without r) followed by r
publish(r):       L := L followed by newly valid r
invalidate(r):    L := L without r
miss:             reserve min(invalid ranks), if any; otherwise remove head(L)
failed admission: no demand refresh
```

Initially L is empty. Unlink, append and head selection preserve the invariant
that each valid rank occurs exactly once and that the head is the oldest
successful admitted demand. Invalidation removes the same rank from its
watch/lookup masks. A free rank cannot require eviction of a valid demand.
The implementation uses two fixed byte-rank arrays and two sentinel ranks;
there is no epoch counter or wraparound argument, allocated list node,
timestamp, sort or growing demand history. Only victim selection/recency
maintenance is O(1); this does not reclassify every existing lookup/write
candidate scan or the entire VM as O(1).

For a crossing source, the first-page lookup is not yet a complete hit:
only successful C-MMU tail admission with the same physical owner refreshes
the rank. A wrong generation/failed tail, source mutation or cancelled
compile pin cannot extend its demand lifetime. C-MMU permission checks on
every lookup, exact physical write revocation, page-wide pending source pins,
generation/rebind/reset behavior and source-slot/table ownership remain.
This is the same serialized single-owner API, not SMP/atomic lease safety.

The owner grows from 6,752 to 6,880 metadata bytes (+128); source payload is
still zero. Capacity stays 64 and the Wasm arena boundary stays 77,824.
The host emitted-byte witness cap stays 262,144 bytes / 1,024 entries.
This correction is not a proof of global topology/quotient minimality.

## Independent checks and actual C-Wasm execution

The native check retains 100,000 replacement/write cases and adds 20,000
independent scan/timestamp-reference cases. It checks exact victim rank,
all valid rows, the entire rank list and watch/lookup masks after writes,
cancelled publications and resets, including colliding physical watch
buckets and poisoned inactive metadata. Both 4,096-demand streams preserve
the continuously used single-page or fully admitted crossing source.
A refused crossing tail leaves the old source as the next victim.

`check-source-admission.mjs` retains its permission, stale, NX/nonpresent,
residency, growth/rebind, MMU A-bit alias, exact-write and table-slot tests.
It adds 512 real cold NOP emissions and 512 hot CLC executions, each through
the C table dispatcher with a complete 1,256-byte CPU comparison. The hot
slot remains stable, and the unchanged 64-slot quota admits every cold source.
There are 536 real cold emissions including the earlier boundary fixtures.
No source opcode or Linux function is emulated in JavaScript.

Full `make -j4 -C src/v2 check` has passing runs, but also the separate native
CALL oracle failure documented below; this is not an unconditional all-green
claim. All linked native VM core ASan/UBSan checks pass. Two positional
reservation test initializers are replaced by
equivalent named initializers to remove missing-cursor warnings. Independent
memory-shift and double-shift fixtures still pass 174,080 and 113,664 direct
comparisons respectively, plus their separately dispatched comparisons,
fault/wait/RF/alias matrices. The 128 independent exception/IRET observations,
1,024 software-interrupt models, boundary-clock/IRQ and REP MOVS regressions
also pass. QEMU TCG is only the native reference/build VM, never the product
execution path or a physical-hardware guarantee.

```sh
make -j4 -C src/v2 check
make -j4 -C src/v2/vm BUILD=FRESH-SAN-DIR \
  CFLAGS='-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all' check
node data/oracle/check-source-admission.mjs VM.WASM COMPILER.WASM
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM BOOT-FIXTURE-DIRECTORY
```

The same short diagnostic ends at 1,616,430 retirements / 1,000,000
admissions, RIP `0x1e21a1a`, with the same independent state/relocation
observations. Cold requests decrease 1,967 -> 1,773 (194 / 9.86%). Engine
constructions remain **1,211**: the removed requests would have hit the
host engine cache anyway. The measured short phase times do not demonstrate
a latency speedup. This does not solve the largest engine-construction cost.

```text
candidate VM 60,998 bytes (+246)
SHA256 dc6e01ad9e795ecb2a1615d1ad0b7f0c11edafb3eba0ff938b1a3beffefcbf51
compiler unchanged: 436,597 bytes
SHA256 13e9d5a54260638be1f6b59e30f8629cb1b5591c84969da5913ef41d06b125f6
native bundle unchanged:
SHA256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

## Same browser Worker; candidate not substituted

The [raw running observation](2026-10-04-source-lifetime-browser-running.json)
is from the **previous** 60,752-byte VM and the SHLD/SHRD compiler, not this
source-lifetime candidate. The tab/Worker has not been reloaded or patched.
The saved intermediate observation is at 166,437,849 retirements / 91,155,901 admissions,
RIP `0xffffffff810c6422`, 6,311 console bytes, 4,631 resident pages and
19,922,944 C memory bytes. Linux logs devtmpfs initialization, POSIX timer
and futex tables and PF_NETLINK/PF_ROUTE registration. Those logs are not
PID 1, a mounted release root, a shell or usable network. The bounded short
diagnostic's pass is not that running receipt's terminal acceptance.

The live observation contains 19,793,514 engine constructions / 2,652,200
exact-byte hits. Engine 1,733,200.3 ms dominates cold emission 276,299.7,
execution 119,266.0, admission 47,310.2 and supply 248.6. These are partial
phase totals, not cold-shell latency, equal-work speedup or boot percentage.
Engine reason counters and the new source lifetime policy were added after
this Worker loaded; neither is presented as a measurement from it.

It subsequently [terminated normally](2026-10-04-double-shift-browser.json)
at 174,000,486 retirements / 96,787,852 admissions and the common -102
LDMXCSR frontier at `0xffffffff81034e31` (`0f ae 54 24 0c`). The full
decompression witness remains identical. The new source policy is still not
a measurement from that old Worker. Close the general ISA frontier, stage
the independently verified VM/compiler with the same shipped kernel and
correct independent segment fixture, then measure the reason counters.
The full PID 1/offline development/storage/network goal and cold shell three
seconds remain unachieved. Native bundle and human UI are unchanged.

## Known native CALL oracle red — retained, not relaxed

The first full product run passed; a later full run failed CALL form 20/row 1
with vector 13 and an unchanged stack word. Eight isolated repeats passed.
A structured repetition then passed 194 times before repeat 195 failed:

```text
form=23 row=81 phase=1 vector=13
target=8000000000000000 operand=12340ffd stack=12340ffd rsp=12341005
before=8000000000000000 after=8000000000000000 flags=a12
error=0 rip=400000 fault_rsp=12341005 fault_flags=10a12 si_addr=0
bytes: 43 ff 54 b5 7f
```

The fixture currently expects a retained return-address store on target #GP.
An earlier system-segments checkpoint independently recorded the same kind
of intermittent failure in form 0/row 1. The source-owner change is not
invoked by this native-only CALL observation. A later full product repeat
passed, but neither failure is relabeled as green or silently discarded.
The expectation, guest CALL lowering and production execution are unchanged;
only failure diagnostics add the chosen inputs, complete initial GPRs,
frame and observed instruction bytes. No retry-as-success is added to checks.

Reviewed [Intel's CALL pseudocode](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf)
(the accessible 2016 volume) and [QEMU 11.1.0's CALL emitter](https://github.com/qemu/qemu/blob/v11.1.0/target/i386/tcg/emit.c.inc).
They describe stack/branch sequencing, but reading them does not prove the
cause of this intermittent observation, physical-hardware payload behavior
or that either model should be changed. Minimize it and obtain an independent
fault/payload oracle before asserting complete CALL equivalence.
