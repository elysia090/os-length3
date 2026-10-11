# Handoff and isolated storage failure checks

Observed on 2026-10-11. The checkout started at `0e71184f720c411bd7432e3cf27c28b6d15b77e8`
on `codex/native-release-wasm-1002`, 186 commits ahead of the fetched origin
`53c98d4046594ce28f9bece0f1fd0adbe575a0d8`. There were eleven modified files,
four untracked oracle scripts and no staged changes. Those inherited working
changes were retained separately from this repair. No applicable AGENTS.md,
workspace .agents or workspace .codex directory was found.

The original thread reports a possible cybersecurity-risk failure without an
operation-specific reason. Its preceding public records include guest transfer
of a diagnostic ELF, DHCP source inspection and console observations. This
handoff did not repeat that diagnostic transfer or execute the diagnostic ELF.
The current work uses isolated host storage and resource mocks.

Existing QEMU build-host, browser servers on 8080/8082/8087 and the x87 remainder
checker were left running. The remainder result file was empty when inspected;
neither process existence nor its empty file is a completed test receipt.
The ordinary shell failed initialization with `setup refresh had errors`;
the normal permission-reviewed elevated shell worked. This initialization error
was not an operation-specific cybersecurity rejection.

## Failure and repair

The new storage failure checker first failed because a failed volume still
accepted writes into an already dirty page. The separate device-close checker
failed because a rejected network close skipped the volume close. Inspection
also showed that a rejected flush skipped the volume's plaintext cleanup and
DB close. A repeated device close previously returned success after the first
close failed, which could hide a failed flush from Worker release handling.

`PersistentBlock` now rejects reads/writes/flush after failure or closure.
Close always clears cached and dirty plaintext and closes the store, retaining
the close promise so repeated/concurrent callers observe the same outcome.
`MachineDevices.close` always attempts volume cleanup after network cleanup,
and repeated callers retain its failure. Root format, encryption, compare-and-
swap policy and guest filesystem semantics are unchanged.

Node 24.21.0 on Windows passes these five checks:

- `node data/oracle/check-persistent-block-failures.mjs`: quota errors at each
  of seven object writes; exact old committed cross-page and distant bytes
  after discarded dirty state and an aborted head commit; rejection of an old
  trusted head after a committed head's notification fails; corrupted-object
  refusal and repair using an independently retained exact ciphertext copy;
  plaintext erasure, quota during close, store close and terminal/repeated close.
- `node data/oracle/check-persistent-block.mjs`: existing sparse-hole,
  cross-page, flush/reopen, corruption/missing, competing-head and creation
  authority regressions.
- `node data/oracle/check-machine-devices-close.mjs`: five resource paths,
  network/volume/both failures, concurrent/repeated close and offline cleanup.
- `node data/oracle/check-memory-budget.mjs`: existing reservation and final
  growth-batch boundaries; live capacity 54710 slots, maximum 3591 Wasm pages.
- `node data/oracle/check-machine-yield.mjs`: existing safe-task scheduling,
  serialized pending yield and close behavior.

The Runtime adapter checks GitHub Actions workflow runs the same checks on
the working branch and pull requests. Its result is separate from local passes.

## Scope and next acceptance

These are isolated durable-store model checks. They do not demonstrate actual
IndexedDB quota exhaustion, browser crash durability, ext4 recovery from an
interrupted write, automatic corruption repair, or reclaiming orphan ciphertext
objects left by a failed pre-publication flush. A failure after head commit but
before trusted-head notification still requires explicit trusted-head recovery;
the code does not silently accept a replacement head or roll it back.

The existing 135-hash, metadata and cold-boot storage receipts remain prior
browser evidence. The publication log
`temp/runtime-publication-oracle-1011b/serial.log` ends with the signed transaction
and policy-negative pass and `selfhost-oracle: pass`; it was inspected, not rerun.
The inherited /var/run compatibility and other publication changes are not part
of this isolated cleanup commit.

`vm_execution_checkpoint` retains two continuation words at a compiled cut.
The VM has no identified complete CPU/RAM/device snapshot restore into a fresh
Worker. Existing cold volume reopening boots the kernel again. A RAM migration
design must establish guest-free pages, C ownership, inflight device fencing,
clocks and entropy before introducing a sparse checkpoint. Guest free RAM,
Wasm logical capacity and host RSS/private working set remain distinct
measurements. Cleanup erasure here is not evidence of immediate host RSS return.

Normal DHCP has a prior ACK/IP/route/DNS/exit-zero receipt. TEST exit139 and
normal/latest explicit-X25519 TLS exit28 remain unresolved; an older successful
X25519 receipt is not a current repeat pass. Real disconnection, reconnection,
parallel guest traffic and prolonged guest-free/host-RSS cycling still need
acceptance runs. This repair does not add a network regrant or guest IP stack.

The published Release remains `os-length3-linux-v0.1.0-rc.1` (2026-10-02).
The loopback oracle serves Wasm as application/wasm with no-store; that is not
a public delivery measurement. The Pages workflow currently builds the shell
without a pinned current browser Release bundle. Prefer synchronizing a
version-pinned, verified Release into the Web origin; check digest, redirects,
MIME and cache behavior there before publication. No new native/browser bundle
or Release is published by this handoff. Current full independent C/ASan,
installed-package repair and complete cold service readiness are still separate
release gates.
