# Native bundle acceptance binding

`check-native-bundle-runtime.sh BUNDLE INPUTS VERIFY ZLIB [RECEIPT]` keeps the
four existing checks: extracted root/ELF closure, native runtime, upstream C
development, and local Git/HTTPS. It always runs them; an old green record is
never a runtime-check cache hit. The optional fifth argument selects an explicit
new receipt coordinate. Otherwise the receipt is named
`BUNDLE.acceptance-<receipt-sha256>.json`. Policy changes need another test run,
not a new post-link compilation of unchanged package bytes.

The runner captures independent regular-file copies of the archive, existing
release `.inputs`, verifier, zlib archive, and the fixed list of test scripts and
their profile/source/bootstrap locks. It hashes the same opened inode while
copying and rejects generation/extent changes. All four checks consume this
private cut; the helper itself executes from the captured policy too. The
archive's extracted manifest must equal the captured `.inputs` bytes. Capture
files are checked before and after the suite. Original coordinates are checked
again before receipt publication; a substituted input cannot receive a receipt
for the prior cut. No live producer path is used by a check after capture.

The environment is cleared and set to the recorded standard host PATH, C
locale, UTC, and trace-off policy, with private HOME/TMPDIR. Nonempty
`QM_NATIVE_*` diagnostic overrides are rejected before execution. The test code
contains the exact command arguments, mount/scratch limits, and thread counts;
its file identities are the test/policy revision. Conditions also record host
system, architecture, kernel, effective uid, and Python version. These are
observed conditions, not a reproducible identity of the host's tools, dynamic
libraries, or kernel build. No Git revision alone is treated as evidence of the
bytes executed. Caller-owned output coordinates and policy inputs must remain
exclusive and immutable during publication. This gate does not resist an
adversarial same-uid writer changing them after return.

The unsigned `native-bundle-runtime-acceptance-v1` JSON receipt binds:

- SHA-256 and extent of the exact archive, `.inputs`, verifier, and zlib input;
- every captured policy file and the aggregate policy digest;
- the recorded conditions and all four individual `passed` results;
- `producer-source-binding=unknown` and `product-qualification=pending`.

Record publication uses a no-clobber hardlink on the output filesystem. An
identical existing receipt is retained; conflicting/legacy/partial records are
not overwritten or automatically upgraded. The build recipe moves a checked
candidate to the stable bundle name without overwriting an existing file,
retains the receipt by its digest, and checks the binding at the final path.
A partially published pair after a crash is not product approval. Existing
native bundles are retested through the same capture path. Their original
bytes and the existing `releases/native/verification/acceptance.env` historical
records are preserved.

`python3 distribution/packaging/native-bundle-acceptance.py verify RECEIPT BUNDLE
INPUTS VERIFY ZLIB` checks local record consistency against the current exact
artifact, policy, and conditions. It rejects another artifact's green result,
changed policy/conditions, changed verifier/source/inputs, incomplete results,
duplicate fields, old schemas, and unsupported source/product approval claims.
This command does not execute the product or authenticate who made an unsigned
receipt. Comparing hashes is not publisher authority or proof that a test
really ran; trusted execution/review must establish the receipt's origin.
Public installation still needs an independently trusted digest/signature.

## Producer gap remaining

`distribution/build.sh` records hashes of selected producer executables. Supplying all
four overrides can skip `make all`; incremental `make all` itself does not
establish a clean reproducible source/toolchain/flags-to-binary correspondence.
Its early producer digest reads and later execution paths can still diverge.
The package content gate and this receipt do not prove that the compiler/stage
which produced an ELF came from a particular source snapshot. This gate fixes
the consumed verifier's identity within the acceptance suite only. The verifier
does not reconstruct the original compiler or certify its provenance.

A future producer gate must consume its own fixed executable cut and
corroborate an actual clean/reproducible build from fixed sources, toolchain,
flags, and dependencies before calling source binding verified. Observed source
hashes, self-declared revisions, existing overrides, or unsupported old producer
history stay unknown. This format rejects a `verified` claim rather than
silently promoting it. No automatic product qualification is available here.

Signed-root regeneration remains a separate key-custody/authority boundary.
Boot/DHCP behavior, cold service completion, performance, production signing
authority, and mandatory workspace recovery after browser restart are separate
pending product gates. This receipt grants none of them.

## Isolated verification

`python3 distribution/packaging/check-native-bundle-acceptance.py` checks 17 portable
binding fixtures. Linux root with `zstd` also runs six end-to-end capture
fixtures, replacing checks only in a disposable policy copy. They cover a
successful archive cut and actual retest, failed-check/no-receipt, retained prior
green after a failed retest, embedded manifest mismatch, and controlled original
archive/verifier substitutions before consumption. Portable negative
fixtures cover artifact/source/verifier/policy/conditions drift, old green and
legacy records, unbacked provenance/product claims, duplicate fields,
no-clobber/idempotence, retained existing directories, detached input copies,
and diagnostic override rejection.
Each rejected ordinary operation preserves inputs, an existing receipt, and a
caller-work sentinel. The controlled substitution fixture retains its deliberate
input change and emits no receipt. Neither fixture suite executes the real
runtime/HTTPS tests, generates keys, runs a diagnostic observer, or qualifies a
Linux/Web product. CI uses `--require-capture` to fail rather than skip these
Linux cases. It emits fixture/helper identities, the accepted fixture archive
and receipt identities/conditions, and this limited scope.
