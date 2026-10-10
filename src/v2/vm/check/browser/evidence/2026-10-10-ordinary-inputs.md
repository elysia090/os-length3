# Ordinary input coverage and independent comparisons

The full GNU-assembler population contains499 declared rows and476838 input
records. It is independent of the product decoder and includes integer/MMX/
SSE/SSE2/SSE3/SSSE3/SSE4 forms, legal register pairs, aliases, address-size/SIB/
displacement edges, immediate controls, machine transfers and deliberate
absent-feature faults. It does not exhaust all15-byte encodings, architectural
states or programs. The [acceptance contract](../../../docs/INPUTS.md) fixes
those distinct obligations instead of treating construction as execution proof.

## Same population before and after

Assembly SHA256:
`9c92b02198a8f173dbb6a3f523cd3bf0e3aa7def60bd768047356363057e03d4`.
Instruction-byte SHA256:
`84994b53b5a13d9e63a61ad05a01e04446fffad91faaed41b0a5f7bf491a5a56`.
GNU assembler identity: `GNU Binutils2.47.20260726`.
Object text including trailing padding has a separate hash; padding is not
silently added to the one-instruction population.

| Same476838 records | Before | After |
| --- | ---: | ---: |
| Accepted construction and valid Wasm |371333|391755|
| Grammar refusals |105504|85083|
| Invalid emitted Wasm |1|0|
| False fault substitution |0|0|
| Wrong source extent |0|0|
| Other refusals |0|0|

Before compiler SHA256:
`a75b771a5b531bb45952c4e13be5ebf3ab05c42105720445728bd5dcada0d27a`.
After compiler SHA256:
`083cb95cfee9fbf0fdea9b89ac5f5ddd4fdce315b1977f479a286adb778c5ade`
(864816 bytes; paired private reservation524288).
The report separately counts476829 ordinary instruction records and9
deliberate architectural-fault witnesses. All9 fault witnesses now compile;
ordinary391746 are accepted and85083 remain red. No profile bit was removed.
The gate itself remains **fail**, not release-wide closure.

The new input guard regenerates the whole declared population and hashes its
assembly and instruction bytes before consulting the compiler. Nine removal/
rename/expectation/hash mutations are refused. Its384801-row synthetic boundary
fixture exercises only the guard, not encoding or execution semantics.

## General fixes

Sixteen XMM families use the existing lane-parametric binary law: signed/
unsigned byte/word/dword min/max, qword equality/signed comparison, low dword
multiplication, signed even-dword multiplication, unsigned narrowing and
byte/word/dword absolute value. The same absolute-value law also accepts MMX.
Memory retains full existing extent/permission/alignment preflight. Equal
registers substitute identity/zero/ones where justified; absolute value reads
only its source. No numeric callback, scalar lane array or alternate executor
was introduced.

The all-input validator exposed a successful CMPXCHG8B emission with an invalid
Wasm stack signature: the8-byte commit called the16-byte pair interface without
its third argument. Both8-byte reserve and commit now use their ordinary
existing interfaces. CMPXCHG16B retains the pair interfaces.

Absent RDRAND/RDSEED now use the fixed CPUID predicate to compile #UD, before
operand observation. Native post-link decoding still retains their exact
extension instructions for superset hosts.96 width/register constructions
plus the existing profile cases pass (123 total); the cold-C fault-admission
checks cover those same96 forms. This is profile enforcement, not a test that
the host silicon lacks those instructions.

## Execution evidence

`check-byte-alu-inputs.mjs` compares actual emitted Wasm with independent
arithmetic/flag equations for ADD/ADC/SUB/SBB/AND/OR/XOR/CMP/TEST on AL/CL.
All256×256 operand pairs and both CF values pass:1179648 comparisons. Poisoned
1256-byte state, RF clearing and incoming flag variation are observed.
TF/breakpoints are disabled; logical AF uses the explicit zero representative.
This exhausts that finite operand domain, not64-bit/MMU/debug/Linux behavior.

Physical Windows observations through the unchanged C VM/MMU pass:

| Population | Forms | Complete state comparisons |
| --- | ---: | ---: |
| Sixteen XMM families |720|23040|
| Three MMX absolute widths |81|2592|

These include aliases, memory,32-bit addressing, REX.W, signed/saturation/wrap
edges and deterministic random values. FPU/XMM/MMX/flags/full tags are physical
observations; unrelated GPR invariance is architectural, not a separately
sampled general-register oracle.

The pinned signed Alpine reference image
`6e2e6fe0572b6632527f268d3659e8fccebda4e1ee470fafe2c4d7b85b6a4df6`
passes product C checks and ASan/UBSan, source snapshot
`05a03bdbb1e3715367d4d625948ddd247032c8e87ecf5640a70b8a2b58d69238`.
Its independent paired-exchange archive has13854720 bytes and SHA256
`f83ba81264e0c51ae7f4d94cf092de2e1457c1887955c1176463649b6e0f9aaf`.
Host readback checks that hash and all360 regular files before extraction.
QEMU/WHPX is an oracle only, with no SSH and only loopback seed transport.

Those72 native-C modules match cold-C emission. Actual C-MMU execution passes
18432 ordinary comparisons,18432 page-fault comparisons,4096 alignment faults,
56192 dispatch comparisons,36864 RF checks,896 waits/retries,576 refusals and216
reservation controls. `elfParity=0`: this run does not claim optimized-ELF
fixture parity or SMP. Native oracle tests are not browser Linux acceptance.

Two failed source/transport attempts and a QEMU vvfat crash were test-harness
failures, not successful gates. Exporting one hash-verified archive rather than
hundreds of files completes the final independent run without changing the
product memory/ISA path or any service deadline.

## Remaining acceptance gaps

The red population is now:

| Domain | Missing input records |
| --- | ---: |
| SSE4.1 |33745|
| SSSE3 |11050|
| SSE |10200|
| SSSE3 MMX |10043|
| SSE3 |7735|
| SSE4.2 |6464|
| SSE2 |5780|
|16-bit register PUSH/POP |32|
| Additional operand boundary witnesses |20|
| x87 |14|

These are encoding records, not weighted runtime frequencies or counts of
distinct semantic families. Remaining large groups include widening,
selection/reduction, sign/horizontal operations, packed floating predicates/
min/max/square-root/conversion and string comparisons. The previous make-only
233455-coordinate inventory cannot replace this population or whole-release
closure. The ordinary automatic browser offline transition still times out;
rescue/manual-warm toolchain success is not cold-ready. No signed bundle,
ordinary root, human UI or browser delivery artifact was overwritten here.
