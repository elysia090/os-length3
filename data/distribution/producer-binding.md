# Producer execution binding

`build-producer-cut.sh` operates only in an isolated Linux build guest or
private mount namespace. It captures the independently pinned source archive,
freezes its inode and the bootstrap tool population, and builds two fresh
source extractions with the explicit compiler, flags and environment. All
five native producer outputs must agree byte for byte. Its fixed cut contains
the compiler, verifier, release-wide stage, archive normalizer and audit.

With `QM_PRODUCER_CUT` and `QM_PRODUCER_EXECUTION_LOG`, the normal release
recipe executes the measured, read-only ELF descriptor using `fexecve`.
The executable pathname cannot substitute another opened inode. The descriptor's
mount must be read-only and its bytes must still match after execution.
Successful and failed real calls record the cut digest, role, arguments,
producer bytes/hash and exit status. Missing or failed required calls cannot
form a complete producer binding.

`producer-binding.py` correlates a complete clean reproduction with those
actual execution records, fixed toolchain files and the independently supplied
final candidate pin. It compares the actual kernel, initramfs and system image
bytes. Archive reproduction is recorded separately because build-tool metadata
may change a new native archive while its installed root stays identical.
The final test reuses the original release inputs and reproduces the original
native archive hash as well.

These unsigned records are observations from the trusted local runner. Checking
them establishes consistency; it does not authenticate a publisher or prove
that an untrusted third party really ran their claimed tests. The historical
native acceptance v1 format remains unchanged and keeps its original `unknown`
producer field. The new exact replay supplies a separate provenance chain for
this reconstructed final candidate; it does not reconstruct the unavailable
history of the old defective producer.

Full native archive reuse now repeats the actual runtime/development/HTTPS
checks and publishes the matching no-clobber receipt just as a fresh archive
does. Prior archives and receipts are retained.

The portable binding fixtures reject changed source/build conditions,
unmatched or missing producer roles, failed/path-only execution, modified
toolchain files and changed final output. The native Linux descriptor fixtures
also exercise actual ELF execution, writable-cut refusal, substituted producer,
duplicate fields and script refusal. Neither fixture suite qualifies a public
release; the candidate's measured release gates remain separate.
