# Fixed post-link comparison

This file fixes the production comparison boundary. Compiler elapsed time,
stored program size, storage transfer size, and native execution time are four
different measurements. None may be substituted for another.

## Accepted inputs

One comparison names:

* the ordinary linked x86-64 ELF SHA-256 and byte extent;
* the post-link compiler source revision and build-id;
* the optimized ELF SHA-256, GNU build-id, byte extent, and embedded source
  identity proof;
* the standard distribution recipe revision, whose upstream archives and
  configuration files are digest-pinned under `distribution/`;
* the workload manifest SHA-256, the content digests of every repository-local
  workload input named by it, and the machine/environment record.

Changing any item creates a new comparison. Results from different identities
are never combined.

The reference distribution must contain the ordinary linked userland **and**
boot objects reconstructed from its ordinary linked kernel and BusyBox. Kbuild's
`arch/x86/boot/bzImage` is mutable wrapping output: packaging an optimized kernel
can update it. Its path or an old timestamp does not certify an unoptimized
baseline. Reconstruct the reference boot image from the digest-pinned
`vmlinux.unstripped`, record both identities, then publish the reference package
root with the same profile, package policy and sources. A diagnostic reference
that deliberately shares the optimized kernel must be labelled as such, not
reported as the complete unoptimized release.

## Saved bytes

The primary executable result is the complete ordinary optimized ELF byte
extent, including its proof. The source comparison is the complete ordinary
linked ELF byte extent. A report also records executable `PT_LOAD` file bytes,
but that narrower number cannot replace the complete-file result.

For the standard distribution, `distribution/packaging/measure-root.sh` measures the
complete canonical filesystem spelling after hard-link and equal-content
identity have been taken. It charges boot objects, unique payload, inode/path/
symlink metadata and xattrs. Compression, transfer framing, caches, build
directories, and compiler elapsed time do not reduce this number. It is an
Artifact-input upper bound; the emitted Artifact program word and Storage
transfer bytes are reported separately.

The post-link report must additionally list every retained population as:

```text
population, logical cells, generated cells, exact cells, stored bits
```

A value proved to be a total function of already accepted input is a generated
cell and contributes zero individual stored cells. Residual state rows,
residual edge rows, coordinate-rank rows, decoded plans, construction graphs,
and source ELF copies are forbidden in the optimized output. A release is red
if their retained count is nonzero, even if compression makes them small.

## Native execution

`build/native-benchmark` owns exactly 401 paired samples per workload; the
count is not accepted from the command line. Production invokes it only through
`distribution/packaging/benchmark-postlink.sh`, whose workload population is fixed
by `distribution/packaging/postlink-workloads.tsv` and recorded by digest.
It performs eight alternating warm-ups and alternates source/optimized order in
each pair. Both files must reside on the same filesystem. `argv[0]`, arguments,
environment, working directory, affinity, CPU frequency policy, and input files
are identical and recorded, except that an explicit `@EXECUTABLE@` token
projects `argv[0]` to each candidate's own path. GCC needs this to locate its
corresponding `cc1`; a bare `gcc` argument makes both candidates fail.
An explicit `@EXECUTABLE_DIR@/` resource is likewise resolved to each
candidate's own directory before the measured interval. The fixed file
classification workload uses its own installed `magic.mgc`, never the host's
database; the runner rejects absent, escaping or unequal resource bytes and
includes their digest in the input record.

Before timing, exit status and the SHA-256 and extent of combined stdout/stderr
must match. Each result reports source and optimized mean and median wall time.
The fixed manifest includes real GCC `-O2` code generation into `/dev/null`
from a header-free C input, so a fast driver `--version` cannot conceal a slow
or crashing `cc1`. Source and optimized drivers find their respective `cc1`
relative to their own installed executable paths; separate native-parity checks
compare their actual assembly bytes.
Besides wall time, each sample records the child's own CPU time (user +
system) and its page faults, read from `wait4` after the measured interval
closed, so their sampling adds nothing to it. They are reported under their
own names (`*_cpu_mean_ns`, `*_faults_mean`); CPU time is never described as
wall time. Retired instructions and cycles are not sampled and are printed
as `unavailable`, never as zero; no result may be described as one of those
counters.

### What the samples can resolve

A mean ratio alone cannot say whether a difference is real. On the
qualification VM, BusyBox against a byte-identical copy of itself gave mean
ratios from 0.93 to 1.006 for a startup-bound workload: the machine's own
run-to-run variation is larger than most differences the compiler makes.
So each result also reports the paired ratio, the geometric mean of the
per-pair ratios (pairs run back to back, so drift cancels within a pair),
with its 95% interval and a verdict: `faster` (interval below 1), `slower`
(above 1) or `within-noise` (contains 1). The production aggregate combines
the workloads' log ratios with the same weights as its weighted mean (each
workload's weight times its source time) and their intervals as independent
errors. The weighted mean ratio is still reported, unchanged.

A measured speed regression still writes the complete comparison with
`comparison=red-speed` and exits unsuccessfully. Losing its per-workload
evidence would hide the actual next optimization witness; keeping that evidence
does not relax the speed gate.

Cold process start, warm process execution, cold Linux shell, and warm guest
workloads are separate rows. A cached run cannot satisfy a cold-start gate.

## Publication gate

Publication requires all of the following on the same accepted identities:

1. semantic parity and the optimized-ELF proof are green;
2. no forbidden retained population exists;
3. complete optimized ELF bytes and canonical distribution payload bytes are
   both lower than their fixed source baselines;
4. output code, physical work, and critical span do not regress, with at least
   one strict improvement;
5. every fixed native workload is behaviorally identical and its declared
   aggregate does not regress: the aggregate interval does not lie wholly
   above 1 (`speed_verdict` is `faster` or `within-noise`);
6. the browser projection is measured only after the native result passes.

The current product is red at the native-emission gate. Consequently there is
no production optimized-size or speed result yet; diagnostic projections and
historical compressed packs are not reported as one.

## Development population checkpoint

The full eager-code catalog is a compiler-coverage diagnostic, not a product
size result.  On 2026-08-29 it used the 19,927,672-byte Linux 7.1.8
`vmlinux.unstripped` whose SHA-256 is
`689a972aa0702828f902abd84c837042ec70912a20a6efaf54836eba62626409`:

```text
./build/block-catalog vmlinux.unstripped --eager-code
```

Extending complete-future projection from a removable prefix to dead
instructions anywhere inside one pure block changed the same 6,771,265
coordinates as follows:

```text
                                      before          after          delta
direct classes                        302,417        318,937        +16,520
direct coordinates                    764,747        788,585        +23,838
selected class output bytes        10,406,441      9,469,420       -937,021
pure source classes                   492,415        484,704         -7,711
pure source coordinates             2,591,249      2,578,627        -12,622
pure source instructions            1,087,859      1,045,115        -42,744
source-plan delta classes             401,304        392,209         -9,095
source-plan delta coordinates       3,491,610      3,480,563        -11,047
retained plan-node delta              651,157        629,643        -21,514
```

The selected bytes are the actual ordinary-x86 compiler output for each
semantic class.  They are not analysis-memory savings.  The complete compiler
gate and all 464 instruction-family witnesses remained green.  The catalog's
source-plan delta intentionally remains diagnostic: fused one-instruction
loads, stores, compares, and exact fault spellings may have more semantic nodes
than retired x86 instructions and are not thereby optimization escapes.

The live interior projection itself covers 11,055 semantic classes and 17,294
coordinates, reducing 65,616 selected source instructions to 49,887 ordinary
x86 instructions.  Direct generation of nested normalized shift/rotate and
flag-preserving complement chains covers another 2,911 classes and 4,120
coordinates.  Across the selected population the maximum emitted work is
64 instructions at `stable_page_flags` and the maximum emitted dependency span
is 41 at `siphash_2u64`.  Their normalized plans are 45 work / 9 span and 63
work / 20 span respectively.  This is the current stateful-owner scheduling
gap: it is not an unsupported-instruction count and cannot be hidden by the
source-plan diagnostic.
