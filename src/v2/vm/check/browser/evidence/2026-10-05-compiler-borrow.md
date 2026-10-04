# Borrowed cold input and the next actual Linux gate — 2026-10-05

The preceding independent same-bundle run has completed at
`0xffffffff81204dec`, common grammar -102 for
`66 0f ef 1d 9c 2f 6e 00` (`pxor 0x6e2f9c(%rip),%xmm3`).
[Receipt](2026-10-05-node-startup-pxor-red.json): 166,527,487 retirements /
90,723,689 admissions, complete decompression agreement, no PID 1, mounted
release root or shell acceptance. This run used the preceding 441,126-byte
PADDQ compiler and separate-memory input copies, **not** the new borrowed
compiler. Raw local receipt SHA-256:
`0c29bc169d839f59d2405420b79f9bb3d8041c9988a0c93144bc27023caf1195`.
Repository JSON normalizes serialization/line endings, not observations.

Its measured maximum remains engine construction: 18,726,588 constructions,
18,725,826 quota evictions, 2,789,860 hits, 761 retained entries / 261,977
bytes. Phase milliseconds: cold 178,486.6; engine 470,084.6; execution
102,425.7; admission 23,032.7; supply 272.5; elapsed 935,061.0. Timing and
calibration variation are not a speedup or a cold-shell benchmark.

## Remove a materialization, retain independent products

For an admitted resident code page, the C-MMU already publishes its physical
offset, virtual coordinate, generation and exact 4,096-byte extent. Previously
the supervisor copied that payload into another Memory on every cold miss.
The copy adds no semantic information. Substitution is instead:

```text
compiler source[i] = (resident physical pointer[i], virtual page[i], generation)
```

The independent C compiler accepts one/two generic fragments in virtual order;
physical order may be reversed or aliased. This is an ordinary borrowed input
API, with no VM dependency, source instruction handler, table publication or
execution admission. Contiguous standalone input delegates to the same image
admission; ordinary ELF input remains supported. There is no startup copy
fallback. Source immutability is a supervisor lifetime obligation, not a claim
that a pointer itself authenticates bytes.

The compiler and VM import one private, single-owner Worker Memory. No SAB,
threads or cross-origin isolation are required. The compiler's own data begin
at 131,072 and its stack is explicitly linked **after** its data. Relocating
data alone with the linker's default stack-first layout would be unsafe.
VM private storage ends at 77,824; compiler arena begins at 516,096; its output
and report reservations end before VM metadata and every guest resident slot.
Guest address translation cannot map these private reservations. Compiler
exports are not guest imports. Compilation is synchronous and no guest writer
runs while a source pin crosses engine construction. C publication still
revalidates the pin before execution admission.

All full output/report reservations are checked against input, even if the
eventual emitted prefix is short. Invalid open closes the previous image;
refusal cannot modify source, output, report or VM private state. Memory.grow
refreshes views on the same Memory identity and retains witness counters,
dirty prefixes and illegal tail writes. Recreating/poisoning the witness on
grow would hide corruption and is not permitted.

The [red-first borrowed input check](2026-10-05-compiler-borrow-comparisons.json)
passes 515 emission pairs / three precise refusals, reversed and aliased
cross-page source, seven invalid opens, five full-reservation overlaps, two
growth checks and VM-private/source immutability checks. The old compiler
fails the new layout/API gate. Output tests retain the original 513 real-C
emissions / three refusals and add growth-during-emission, foreign Memory and
subview refusal, plus corrupt-tail retention across growth.

The new 441,878-byte compiler SHA-256 is
`f3d346fb1d1ac7a98ca635ef6ba4b230819556176bd1c59c96299b6eeb005dbd`;
VM is unchanged. All 40 vector, 108 scalar-vector and 16 MXCSR native/cold
emissions and complete CPU/RAM/fault checks remain identical. The same default
one-million-admission run retains 1,616,430 retirements, 620,243 emitted bytes,
all architectural/source/trace/resource observations except explicit clock
sampling/UTC and the measured compiler/memory/copy fields. Copied source bytes
fall from 7,262,208 to zero (the same amount is borrowed). Combined Memory
falls from 6,815,744 + 1,048,576 to 7,340,032 bytes: 524,288 fewer allocated
bytes under the same growth quantum. This is not an RSS measurement or a
significant speedup claim: diagnostic elapsed is 2,245.6 vs 2,208.7 ms, with
cold C 30.1 vs 30.9 ms. Engine churn/topology remains the larger fixed cost.

The independent extended borrowed-source run has now completed at the same
PXOR gate: [separate receipt](2026-10-05-node-startup-borrowed-pxor-red.json),
158,854,007 retirements / 85,286,564 admissions. All 14,622,864 decompressed
bytes agree. It borrows 66,443,194,368 source bytes with **zero** copied code
bytes and no separate cold Memory; allocated Memory is 20,512,768 bytes.
Engine construction remains dominant: 13,651,494 constructions, 13,650,750
quota evictions, 743 entries / 261,998 retained bytes. Phase milliseconds:
cold 138,267.0; engine 339,759.4; execution 79,788.9; admission 21,015.8;
supply 182.4; elapsed 710,605.5. Variation in calibration/work means comparison
to the previous run is **not** a speedup. Raw local receipt SHA-256:
`a7c10087c2fe96e401d3d6e83e764006f2a9ef86d4bf078926217655e24721cc`.
No PID 1, release-root mount or shell is accepted by this receipt.
No retained browser Worker was restarted
or observed through a policy workaround. Native delivery and human UI are
unchanged. Browser/PID 1/shell, storage/recovery, network, strict CALL and the
Windows RTC oracle reds remain open; three-second cold shell is unmet.
