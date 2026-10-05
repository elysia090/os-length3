# A string element is not a one-count REP — 2026-10-05

The completed frozen `f1cd38c` same-bundle run passes SYSCALL and stops at
unprefixed MOVSB `a4`, RIP `0x7f997650c1f2`, compiler -102.
See the [exact real input/CPU receipt](2026-10-05-node-startup-movs-red.json).
A new common native compiler check independently fails at form 0 with -102
before this change. The existing lowerer admits only REP, not this one-element
instruction. No opcode is skipped and no guest syscall/VFS is implemented
outside Linux.

## Exact normal form

For operand bytes k, address width w, incoming DF and mask M = 2^w - 1:

    delta = DF ? -k : k
    source = old_RSI & M
    destination = old_RDI & M
    value = MOVS ? read_k(source) : low_k(old_RAX)
    write_k(destination, value)
    on success only:
        RSI' = MOVS ? (source + delta) & M : old_RSI
        RDI' = (destination + delta) & M
        RCX' = old_RCX
        RIP' = source_entry + source_length
        RF' = 0
        retired' = retired + 1

Load precedes store, including overlap. The common C MMU preflights a complete
possibly split element before any payload store. Failure/wait publishes no
pointer, count, RF or retirement changes. In particular, faulting 32-bit
pointers preserve the incoming upper halves; successful updates zero-extend.
Ordinary paging A/D effects retain their existing architectural contract.

No count, quantum loop or partial frontier exists without REP. RCX=0 does NOT
suppress the element. REP reuses the same load/store element, with its existing
bounded loop and completed-element publication on a partial return.
STOS neither reads nor writes RSI; RAX is read but never written.
The distinction is compile-time, not a runtime instruction decoder.

The source's normalized segment, not a prefix byte guessed in isolation,
controls access. Four separate native observations show that legacy SS/DS
override bytes on long-mode MOVSB/REP MOVSB do not turn RSI into a stack
reference: noncanonical RSI faults #GP, not #SS. FS/GS-base forms remain
explicit compiler -102; debug/alignment entry contracts remain explicit
refusals. The instruction contract is described by
[Intel's instruction reference](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html).

## Counted evidence

The fresh native recipe executes all 16 MOVS/STOS forms (8/16/32/64 operands,
32/64 address width). It records **256 successful** and **992 faulting**
whole-GPR/flags/payload observations. Cases include both DF values, zero/one/
large RCX, high 32-bit parents, source/destination overlap, first and split
element page faults, competing source/destination absence and noncanonical
64-bit pointers. Faulting CPU/payload must remain unchanged. Hardware exception
delivery adds RF to its saved flags; that is not an instruction update.

The [green receipt](2026-10-05-string-element-green.json) verifies 16 byte-exact
native-C/cold-C emissions and **1,248 direct + 1,248 actual C-dispatch**
native-derived comparisons. Unobserved CPU fields and hidden caches are
unchanged explicit models, not claimed hardware observations.
24 residency waits/resumes use actual C page prepare/commit and a latched
source row, despite caller mutation of its entry/slot/binding. Duplicate
commit is refused; no payload fragment, pointer or RF publishes while waiting.
80 entry/generation/TF/AC/alias refusals, 16 RF models, four native ignored-prefix
fault comparisons and four FS/GS compiler refusals pass.

Existing REP MOVS and STOS each retain 336 native CPU/RAM comparisons,
144 bounded resumes, 184 entry/stale refusals, two code-alias continuations
and 24 RF models; MOVS has 88 and STOS 66 partial/fault/miss cases.
Entry-binding, direct CALL sharing, SYSCALL/native-C parity and full native
compiler/CLI checks pass. Scoped GCC ASan/UBSan instruments the compiler and
new fixture, not separately linked provider libraries; no new warnings.

The generalized file is `lower-string.c`; the old `lower-repeat.c` is removed.
The static library is rebuilt from exactly its current object list when the
Makefile changes: `ar rcs` alone had retained the renamed obsolete member and
caused a duplicate frontier symbol. This fixes incremental build correctness,
not an elapsed execution-speed claim.

Compiler is **452,030 bytes** (+275 over the CALL candidate), SHA-256
`9f499cdb551596413e13a1c0536ce3fee79e1650bda7406ebb69ad4f42f256c4`.
VM remains 69,903 bytes; entry ABI/rows/report/native release/UI/quotas are
unchanged. Next: the same bundle, independent segments and immutable root,
warmCuts=64. Local green is NOT successful PID 1, root mount, shell or browser
acceptance; the three-second cold shell remains unmet.
