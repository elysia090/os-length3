# Ordinary store prefixes — 2026-10-10

The fixed CPUID surface remains unchanged, including its clear ERMS bit.
REP-only optimization is insufficient for ordinary compiler-generated stores.
The common cold frontend now groups up to16 adjacent plain64-bit MOV stores
with the same GPR value and effective-address lineage. No kernel symbol or RIP
is recognized. Source instructions/encoding remain the ordinary x86 input.
Implicit SS, FS/GS, changed value/address lineage, page-crossing code and other
effects stop this first proven class rather than being silently reinterpreted.

The same homogeneous C memory operation returns the exact completed prefix.
Actual retirement must fit the attested source bound; a partial RIP remains
inside its source span. A fault/resource wait after a committed prefix keeps
those effects and its precise next RIP. One suspended instruction still has
zero retirement until completion. The producer computes the source-byte prefix
from ordinary encoding lengths; common equal strides use one affine expression.
No CPU snapshot, new saved program format or guest interpreter is introduced.

Source fetch is also an observation. During a composed transfer the C owner
borrows only the code page's physical extent and at most4 ancestor offsets.
A changed code-translation byte or any current source-code write clips the
data span after its first affected word. The next source admission rewalks and
recompiles, or delivers the exact fetch fault. Data translation has the same
ancestor cut. The C callback table slots are reserved before dynamic guest
placement; an actual signature-collision red identified and fixed that bound.
Memory capability bits2+4 require the completed-prefix and retirement contracts;
older incompatible providers are refused before startup/replacement.

4096 constructor GPR/base/budget cases pass. Six actual emitted C/Wasm models
cover full8-store completion, page-limited prefix, atomic cross-page fault,
code-byte alias and code-translation alias, RF and exact retirement. These
particular six are architectural models, not independent CPU observations.
Existing196608 independent SSE and30720 FRNDINT whole-state comparisons pass.
Independent full Linux C/MMU/memory and ASan/UBSan gates pass with source
`9d1640e0638fbb0f0cac3fea1235d3f10f43f2515de7294cbe15a58c338c72b6`.

The same-provider benchmark uses the same8-source-instruction x86 program,
16384 repetitions/sample over7 rounds, including reset/bind/source/MMU costs:
8 modules/2648 bytes/22.3333ms ->1 module/446 bytes/7.2050ms (ratio0.3226).
This is a scoped3.1x execution improvement and84% module-byte reduction, not
a Linux boot speed or release-size claim. The complete initial startup prefix
also passes without removing REP/BSS/memset/decompression assertions.

The actual ordinary rebuilt-root browser still reports an offline service
transition timeout after supervision initialization; native C improvements are
not treated as a substitute for that observation. A separate rescue diagnostic
root changes only the failure trap to open the Linux console. It explicitly
prints NOT interactive-ready, preserves the real10s deadlines, and is never
published or counted as normal distribution readiness. Its purpose is to
inspect actual Linux/s6 processes and `/proc`, not emulate them on the host.
