# Storage and recovery

## Responsibility

This document derives the storage, delivery, cryptographic, erasure, lifetime,
and recovery design from its required properties.  It does not define the
meaning of an executable.  Canonical machine identity and executable
equivalence are defined in [ARTIFACT.md](ARTIFACT.md).  Linux remains the only
VFS, dcache, path resolver, page cache, and filesystem implementation.

Storage below Linux knows only canonical object ranks, byte extents, immutable
roots, and physical delivery coordinates.  It never interprets a pathname,
inode, executable instruction, or guest syscall.

Native and browser delivery have different resource adapters without acquiring
different object identities. Native may map verified extents with `mmap`, let
the host page cache fault them, batch I/O asynchronously, and discard clean
mappings under ordinary process pressure. Browser delivery faults the same
authenticated extents through fetch/browser persistence, holds dirty COW pages
outside disposable Workers, and drops Worker-owned Wasm memory on eviction.
The tier mechanism changes; admission through the canonical root does not.

OPFS, IndexedDB, Cache and Web Locks are adapters,
not guest VFS or a distributed root authority. A successful cache write or
`persist()` grant does not prove remote durability. Connection operation ACKs
must pass generation/revision fencing and then storage authentication; only
the receipt/quorum and root-CAS contract below can acknowledge a durable commit.
User-selected plaintext import/export is an explicitly granted transfer outside
the managed ciphertext tiers. It never creates a browser POSIX filesystem.

## Key custody and recovery authority — current implementation

Package verification uses public keys; writable storage uses secrets. Their
authorities are not interchangeable. Package custody/download bootstrap are in
[PACKAGE.md](PACKAGE.md). This section describes actual browser code, not
completion of every derivation below.

| Material | Owner / purpose | Can an untrusted tier supply authority? |
| --- | --- | --- |
| master `CryptoKey` | Supervisor-supplied HKDF secret; imported and derived keys are non-extractable | No. Ciphertext availability is not key recovery. |
| volume ID and salt | Public 128-bit ID and 256-bit CSPRNG salt, bound to root AAD / derivation | Bytes may be stored, but selecting the volume context requires retained trusted authority. Salt is not a recovery secret. |
| expected head envelope | Supervisor's exact committed head pin | No. An older valid head still passes AEAD; comparison with the retained pin detects replacement/rollback. |
| machine generation / resource binding | Fresh execution and operation authority | No. Neither is an encryption key or a substitute for head freshness. |

`ciphertext-storage.js` derives volume roles `volume-root`, `volume-metadata`
and `row-locator`, and object roles `row-aead` and `row-auth`. HKDF info includes
the fixed domain, protocol version, length-delimited role and context; object
context includes volume ID, canonical digest and generation. Root/metadata keys
use AES-256-GCM; locator/row-auth keys use HMAC-SHA256. HMAC keys are symmetric
secrets, **not** APK signing/public key pairs.

Production `PersistentBlock` uses its root key for encrypted heads and its
metadata key for encrypted directory/page objects, with role/coordinate-bound
AAD and ciphertext-hash locators. It does not yet route those pages through
the prototype's object-row AEAD/erasure projection. Encrypted-block recovery
does not prove completion of the row/ECC or C-only admission design.

An explicit new workspace creates a 32-byte CSPRNG master input, imports a
non-extractable HKDF `CryptoKey` and clears the input buffer. The user-approved
origin/profile retains that CryptoKey, volume context, exact committed head
and Supervisor generation in an IndexedDB authority store. Head and recovery
pin advance in the same strict transaction; Web Locks and generation fencing
prevent concurrent/stale Supervisors. Ciphertext objects
remain separate from this trusted authority. Worker close/reopen cold-boots
Linux; it does not restore guest processes.

The local browser profile is part of the trusted coordinate. Site-data deletion
loses its key and recovery metadata. Non-extractability does not protect a
compromised origin, detect rollback of the entire trusted profile, guarantee
memory erasure or recover after key loss. There is no portable recovery-key
export, password wrapping or cross-device key distribution. Existing unknown
ciphertext is never silently reformatted or adopted under a replacement key/head.

Cloud recovery still needs a separately trusted durable intent/head mechanism.
The optional HTTP ciphertext transport and its fetch/push contract are in
[DELIVERY.md](DELIVERY.md); no cloud tier is configured by default.
Master-key rotation needs old-volume access, a new key/context and verified
migration, not simply a new secret at the old coordinates. These are remaining
contracts, not present UI features. [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html)
defines the derivation interface; it is not a security audit of this product.

## Required properties

Let `A` be the canonical executable or filesystem object and let `T_i` be any
memory, browser-cache, local, CDN, cloud, or backup tier.  The design must meet
all of these properties simultaneously.

1. **Untrusted tiers.** No `T_i` is trusted for integrity, freshness, or
   confidentiality.  Tier order is only a latency and availability policy.
2. **Exact admission.** Bytes become resident only if they are the requested
   canonical object interval and generation.
3. **Bounded touch.** Reading one physical interval does not fetch, parse, or
   retain an object-sized prefix.
4. **Bounded residency.** Clean pages and execution workers are disposable;
   dirty state and a small authenticated root survive.
5. **Loss tolerance.** A declared number of missing or corrupt stores can be
   recovered without exposing plaintext to those stores.
6. **One filesystem cut.** All committed filesystem state is selected by one
   constant-size root updated with linearizable compare-and-swap.
7. **Crash and restart safety.** Old workers, acknowledgements, reservations,
   and supervisors cannot mutate a later generation.
8. **Canonical retry.** Retrying an operation does not create a second object
   spelling or repeat AEAD encryption under one key and nonce.
9. **Minimal retained information.** Equality, zero support, closed-form
   structure, and complete-future equivalence are removed before compression,
   encryption, and erasure coding hide them.
10. **Single execution path.** JavaScript may supply opaque ciphertext ranges
    and WebCrypto operations; canonical parsing, rank selection, machine state,
    and VM execution have no JavaScript or Python fallback.

The rest of this document consists of consequences of these requirements.

## Derivation 1: immutable canonical objects

Suppose a storage coordinate could change from plaintext `x` to `y` while its
identity remained `d`.  A reader of `d` could then observe two values, violating
exact admission and canonical retry.  Therefore an object identity must bind
both extent and bytes, and a published coordinate is immutable.

For canonical bytes `x`:

```text
object_id(x) = H(domain || length(x) || x).                     (1)
```

The current implementation uses SHA-256 with fixed domain labels.  Complete
digest equality is followed by complete byte equality when building a quotient;
a hash collision cannot merge semantic objects.

Mutation creates a new object and a new root.  Retry resends the same immutable
bytes.  A tier that already holds different bytes at the same opaque locator is
rejected instead of overwritten.

## Derivation 2: quotient before encryption

Let logical pages be `P_0 .. P_(n-1)`.  Define:

```text
i ~= j  iff  P_i = P_j byte for byte.                           (2)
```

Rank zero denotes the all-zero page.  Nonzero classes are ranked by the first
logical coordinate at which the exact bytes occur:

```text
rho(i) = 0                         when P_i is all zero
rho(i) = rank of [P_i] under (2)   otherwise.                   (3)
```

The logical object is now:

```text
(length, page_bytes, rho, unique_page).                         (4)
```

If randomized compression or encryption were applied before (2), equal
plaintext could have unequal stored bytes and the quotient would be lost.
Hence the only permissible order is:

```text
canonicalize -> exact quotient -> canonical byte-region program
             -> delivery-code selection -> frame/pad
             -> encrypt -> erasure project.                    (5)
```

The canonical byte-region program is the single Artifact word derived in
ARTIFACT.md.  It selects structural, affine, rank/select, prior-factor,
dictionary, recurrence and literal programs together with their exact
residuals; it does not first open a byte word for Deflate.  Delivery coding is
separate and cannot change that identity.  A delivery profile may select
Deflate or another transport codec only by charging its decoder, framing,
touch, work, span and resulting bytes, with a fixed canonical tie break.  It
stores one selected delivery spelling, never both compressed and uncompressed
owners.  A build which feeds fixed dispatch, state, edge, descriptor or opened
payload rows directly to that codec has skipped the first three arrows and is
nonconforming even when the resulting file is smaller.

The inverse admission order is:

```text
fetch opaque row -> authenticate stored row -> reconstruct ciphertext
 -> AEAD verify/decrypt -> reject frame/padding errors -> decode delivery word
 -> verify canonical extent and digest -> publish resident page. (6)
```

No earlier stage in (6) is allowed to publish plaintext.

The map `rho` is itself a finite function and is encoded by the predictor plus
enumerative-residual construction in ARTIFACT.md.  A dense `u32[page_count]`
array is an opened cache, not the wire form.

The population sizes are derived before rows are built.  For object length
`L` and logical page extent `P`:

```text
N_logical = ceil(L / P)
0 <= N_unique <= N_logical.                                   (6a)
```

The exact byte quotient supplies a total surjection
`rho : [0,N_logical) -> [0,N_unique)`, with rank zero reserved for the implicit
zero page and every nonzero rank used.  Thus `N_logical` is fixed by extent,
`N_unique` is bounded by it, and exact quotient coverage supplies the matching
lower bound.  The release stores the selected total program for `rho` and its
exact exceptions; it does not store one word per logical page merely because
the builder used such a vector while proving coverage.

## Derivation 3: direct physical coordinates

A hot lookup cannot search paths, hashes, or storage tiers after the page is
resident.  Equations (3)--(4) give the unique direct coordinate:

```text
logical_page -> unique rank -> resident[rank].                  (7)
```

The zero rank returns the implicit zero page and does not allocate a resident
slot.  Equal logical pages use the same nonzero slot.  The hot dependency chain
is two indexed loads; hashing exists only while constructing or admitting the
projection.

For a miss, a nonzero rank maps bijectively to one encryption row coordinate:

```text
rank <-> (capacity class, group, slot).                          (8)
```

Both directions are fixed arrays only after the small selected directory is
opened.  They are not additional semantic identities.

## Derivation 4: minimum-byte ciphertext grouping

Compression produces variable encoded extents `e_r`.  AEAD and systematic
erasure coding require equal row sizes within a group.  Let `q` be the declared
allocation quantum and:

```text
c_r = q * ceil(e_r / q).                                       (9)
```

Sort rows stably by `(c_r, canonical rank)`.  Let a group contain `m <= k`
data rows, `p` parity rows, capacity `c`, AEAD tag bytes `t`, stored-row
authenticator bytes `a`, and group metadata `h`.  Its exact stored cost is:

```text
group_cost(m,c) = (m + p) * (c + t + a) + h.                  (10)
```

An exchange of two crossed capacities never increases either group maximum.
Therefore at least one optimum partitions the sorted order into consecutive
groups.  The complete optimum is the bounded recurrence:

```text
DP[0] = 0
DP[j] = min_(max(0,j-k) <= i < j)
          DP[i] + group_cost(j-i, c_(j-1)).                    (11)
```

Equal costs are ordered by group count, then wider final group, then
predecessor rank.  This yields one canonical partition.  It is a necessary and
sufficient dynamic program, not a bin-packing heuristic.  Fetch performs no
min-plus work; it uses (8) directly.

## Derivation 5: encryption coordinates

Every tier may inspect its stored keys and bytes, so storage locators and rows
must reveal neither plaintext nor canonical object identity.  One master key
derives independent keys by role:

```text
K_role = HKDF-SHA256(master, salt,
                     protocol || role || volume || object context). (12)
```

Roles are distinct strings for volume root, metadata, row AEAD, stored-row
authentication, and opaque locator.  The object context includes the canonical
object digest and generation.  The object salt is a 256-bit CSPRNG value.  It
is public but authenticated as object metadata and is never used as a secret.

For one object key, the data-row nonce is:

```text
nonce(group,slot) = domain32 || uint32(group) || uint16(slot) || zero16.
                                                                    (13)
```

With `group < 2^32` and `slot < 2^16`, (13) is injective into 96 bits.  The
implementation must never encrypt the same `(object salt, generation, group,
slot)` twice.  A retry returns the retained immutable ciphertext; it does not
invoke AES-GCM again.  A new encryption uses a new object generation and salt.

Equation (13) is the browser row prototype's little-endian `ROW1` spelling.
The C coordinate helper currently spells `LE64(group) || LE32(slot)` instead;
it is not a byte-compatible AEAD row implementation of (13). Production
`PersistentBlock` currently uses fresh random96-bit root/metadata envelope
nonces, not either row spelling. These are explicit implementation gaps, not
three interchangeable storage formats. Consolidation must bind the chosen
spelling/version to keys and authenticated metadata, without accepting the
other spelling as an implicit fallback.

AEAD associated data binds:

```text
(protocol, algorithm, object salt, canonical object digest,
 generation, group, slot, row class, capacity,
 frame version, codec, canonical extent, encoded extent).      (14)
```

Changing any coordinate in (14) makes the row fail authentication.  Opaque
storage lookup is:

```text
locator = HMAC(K_locator,
  domain || volume || object salt || object digest
         || generation || group || slot).                      (15)
```

A separate 128-bit HMAC over `(domain, locator, ciphertext)` filters corrupt
stored rows before erasure reconstruction.  This pre-reconstruction check is
necessary: AEAD alone can reject a reconstructed result but cannot identify
which candidate shard was corrupt.

## Derivation 6: erasure on ciphertext

Parity computed over plaintext would expose a linear function of plaintext to
an untrusted parity tier.  Encrypting independently after parity would also
require decrypting multiple rows before recovery.  Requirements 1 and 5
therefore force erasure coding over equal-sized ciphertext rows.

Use a systematic Reed--Solomon code over `GF(2^8)` with `k` data and `p` parity
rows.  Let `V` be the `(k+p) by k` Vandermonde matrix and `V_0` its first `k`
rows.  The systematic generator is:

```text
G = V * inverse(V_0).                                          (16)
```

The first `k` rows of `G` are the identity.  Any selected `k` rows `G_S` are
invertible.  For authenticated available ciphertext rows `Y_S`:

```text
D = inverse(G_S) * Y_S                                         (17)
```

and target data row `t` is:

```text
D_t = row_t(inverse(G_S)) * Y_S.                               (18)
```

For a fixed small geometry, every `k`-of-`k+p` availability mask has one
canonical ordinal.  Its coefficient row in (18) is computed before publication
and authenticated as encrypted metadata.  Recovery performs direct mask lookup
and one QM-minimized GF(256) vector combine; it never inverts a matrix on the
page path.

Corrupt or unauthenticated candidates are absent from `S`.  Recovery succeeds
iff at least `k` authenticated rows remain.  The reconstructed ciphertext still
passes AES-GCM and canonical digest/extent checks in (6).

## Derivation 7: rank-addressed delivery

If a consumer already holds a canonical object rank, searching by a repeated
256-bit digest adds information and work without changing the selected object.
Therefore delivery lookup is by canonical interval rank.

1. Canonical intervals are ordered by bit rank.
2. Equal intervals are interned before compression and encryption.
3. A leaf carries one bounded interval or one shared interval rank.
4. A branch carries child commitments and subtree byte counts.
5. Pack offsets are prefix sums of subtree counts and are not repeated in each
   leaf.
6. One root-to-leaf path authenticates the selected interval.

For branching factor `B` and `N` intervals:

```text
resident_path_nodes <= ceil(log_B N) + 1.                       (19)
```

The maximum leaf extent is a declared fetch-amplification bound, not a fixed
4 KiB assumption.  Independently authenticating `N` arbitrary leaves at
`lambda`-bit security has an `Omega(N*lambda)` commitment/tag term unless a
stronger vector-commitment assumption is adopted.  Leaf size is selected by
the physical objective after this unavoidable cost is charged.

The delivery root is a signed projection of the canonical artifact identity.
Repacking, re-encrypting under a new generation, or changing erasure placement
changes the projection root but not the executable identity.

Every delivery population also has a construction-independent bound.  If the
canonical byte stream has `C` bytes, the maximum authenticated leaf payload is
`G`, the directory fanout is `B >= 2`, and each group holds at most `k` data
rows with `p` parity rows, then:

```text
N_leaf       = ceil(C / G)
N_internal  <= ceil((N_leaf - 1) / (B - 1))
N_group      = ceil(N_row / k)
N_ciphertext = N_row + p * N_group.                            (19a)
```

Content quotienting can reduce `N_leaf` and `N_row`; it cannot increase these
bounds.  A build report must cite the bound that creates each interval and a
total rank generator for it.  A directory count discovered by appending rows
is only a materialization count, not evidence that the population is complete
or necessary.

## Derivation 8: tier behavior

Because no tier is authoritative, all tiers implement only:

```text
get(opaque locator) -> (ciphertext row, authenticator) or absent
put(opaque locator, immutable ciphertext row, authenticator)
```

Lookup tries tiers in configured latency order.  A rejected candidate is
ignored and lower tiers are tried.  A valid lower-tier ciphertext row may be
promoted upward before decryption.  Plaintext is never promoted into a
persistent tier.

This makes in-memory cache, browser cache, local storage, CDN, object storage,
and cloud replication equally untrusted.  Their only differences are latency,
capacity, availability, and retention policy.

## Derivation 9: one strongly consistent root

Filesystem changes write immutable objects first.  Let `O` be the sorted set of
object identities reachable from a manifest `M`:

```text
object_set_root = H(domain_set || |O| || concatenate(O)).       (20)
```

One constant-size root descriptor is:

```text
R_n = H(domain_root || n || R_(n-1) || M || object_set_root).   (21)
```

The backing service exposes one linearizable compare-and-swap of the opaque,
encrypted head envelope:

```text
CAS(expected = envelope(R_(n-1)), replacement = envelope(R_n)). (22)
```

All referenced objects and the manifest are durable before (22).  The
linearization point is the successful CAS.  Failure leaves immutable orphan
objects but cannot expose a partial filesystem.  Exact retry reuses the same
prepared root envelope; it does not re-encrypt with the same nonce.

Restore appends a new root whose manifest and object set equal a pinned older
snapshot.  It never moves the head sequence backward.  A provider without
conditional write cannot claim one linearizable volume; conflicting writers
remain immutable branches.

## Derivation 10: finite atomic ownership

Tag validation followed by an unpinned memory access has a TOCTOU window.
Separate atomics for phase, owner, and acknowledgement permit inconsistent
combinations.  Therefore every resident slot has one atomic ownership word:

```text
slot = (phase, arena generation, owner, lease token).           (23)
```

The word width is the native atomic width `W` (64 bits for wasm32 atomics).
Widths are derived from declared maxima:

```text
b_phase = ceil(log2 phase_count)
b_owner = ceil(log2 (worker_limit + 1))
b_arena + b_lease = W - b_phase - b_owner.                     (24)
```

Publication fails if configured limits do not fit (24).  Counters never wrap.
Before the next value would repeat, the arena enters `RETIRED` and a fresh
arena is allocated.  Across supervisor restart, a separate random 128-bit
incarnation is part of every external acknowledgement, so a session-local
atomic word cannot be confused with an older process.

The phases are:

```text
FREE -> CLEAN -> OWNED -> DIRTY -> FLUSHING -> CLEAN
                    \-> CLEAN
any quiescent phase -> RETIRED.                                (25)
```

Only the owner holding the exact token may access or change an owned slot.
Access APIs receive the token and verify (23); ownership prevents another
actor from changing the word until release.  An acknowledgement is a CAS from
the exact leased word.  Duplicate acknowledgement observes the completed state
and cannot apply an effect twice.

## Derivation 11: cross-page reservation

One x86 memory operation can cross a page boundary.  Publishing one page while
the other is unowned would expose a partial architectural operation.  Required
pages are therefore reserved as one transaction:

1. enumerate the exact finite page set;
2. sort by physical coordinate;
3. acquire in that order;
4. on one failure, release the acquired prefix;
5. perform no access until the whole set is owned.

Global coordinate order removes deadlock.  Scalar x86 accesses reserve at most
two pages.  String operations are split at a persistent cut and reserve a
bounded chunk; they never hold a reservation proportional to an unbounded
count.  A ticket or bounded-yield queue prevents a stream of one-page requests
from starving a waiting cross-page request.

A trap, Wasm exception, worker termination, or explicit cancellation runs the
same release transition.  The supervisor owns a lease table outside the worker
so termination cannot hide reservations.

## Derivation 12: supervisor fencing and lease reclamation

Timeout alone cannot prove that an `OWNED` or `FLUSHING` worker is dead.  A new
supervisor first wins a durable fence:

```text
supervisor = (random 128-bit incarnation, monotone generation). (26)
```

Only then may it reject older acknowledgements and reclaim their intents.  A
stopped worker cannot mutate storage because every write lease contains (26).
`FLUSHING` recovery checks the immutable objects, manifest, and root CAS result:

* if the root is current, the flush is already committed;
* if the prepared exact CAS can still succeed, retry it unchanged;
* otherwise abort the intent and leave its objects for fenced orphan GC.

There is no state in which a guessed timeout publishes dirty bytes.

## Derivation 13: orphan collection

Let `a(o)` be the monotone allocation ordinal of object `o`.  A collector first
captures fence `f`.  Under the same supervisor fence and volume lock, define
`Live` as objects reachable from the current root, pinned roots, and every
active publication intent.  The exact deletion condition is:

```text
collect(o) iff a(o) <= f and o not in Live.                     (27)
```

Objects allocated after `f` are never considered.  Roots and intents are
rechecked at the linearized sweep.  These two conditions are necessary: omit
the allocation fence and a concurrent new object can be deleted; omit one live
root or intent and a valid future restore or publish can be destroyed.

Retired arenas are reclaimed only after every slot is quiescent, every lease is
absent, and no pinned root names their dirty objects.  Capacity is bounded by:

```text
live slots <= clean_cache_limit + dirty_working_set
              + active_reservations + active_flushes.          (28)
```

Counter exhaustion can create another retired arena but never reuse an old
token.  If reclamation cannot keep this bound, allocation fails explicitly
rather than weakening ABA safety.

## Recovery sequence

After browser or supervisor restart:

1. generate a new supervisor incarnation and win its monotone fence;
2. read and authenticate the opaque head envelope;
3. authenticate the fixed root descriptor and selected manifest path;
4. reject or finish old immutable publication intents as described above;
5. rebuild only root-to-leaf directories and touched ciphertext rows;
6. reconstruct, AEAD-open, decompress, and verify pages on demand;
7. restore dirty COW pages named by the committed root;
8. start a fresh VM worker and reject every old worker acknowledgement.

Clean native mappings, Wasm memory, decoded rows, backend modules, and plaintext
page caches need not survive.  The persistent recovery cut is the root, dirty
objects, and the small supervisor metadata.

## Work, span, and residency bounds

For a resident logical page, (7) has constant work and two-load dependency
span.  For a miss, directory selection touches one path:

```text
directory work/span = O(log_B N).                              (29)
```

For `k` useful ciphertext rows of `b` bytes, Reed--Solomon recovery has:

```text
work = Theta(k*b)
span = Theta(log k) with a balanced lane reduction,
       or Theta(k) for a fixed small serial row reduction.      (30)
```

All byte coordinates are independent lanes.  The post-link compiler selects
the minimum exact GF(256) kernel under the same
`(span, work, code length, rank)` objective as the executable artifact.  The
selected native x86 kernel is verified and benchmarked first; a browser Wasm
kernel is only its separately verified backend projection.

For a trace `t`:

```text
resident(t)
 <= authenticated_path(t)
  + clean_cache_limit * page_bytes
  + loaded_module_limit
  + dirty_pages(t) * page_bytes
  + bounded ingress/egress queues.                              (31)
```

This is independent of virtual RAM extent and unrelated cold toolchain bytes.
Reports keep logical, unique, stored, fetched, decrypted, resident, dirty, and
parity bytes separate.  They also print
`(N_logical, N_unique, N_leaf, N_internal, N_group, N_ciphertext,
resident_slots)` with the upper-bound witness and coverage result for each
term.

The exact stored row term for capacities selected by (11) is:

```text
stored = sum_groups group_cost
       + encrypted metadata
       + authenticated rank directory
       + root and path commitments.                             (32)
```

It is compared with the structural artifact lower bound from ARTIFACT.md.
Compression ratio alone is not a storage proof.

## Falsification gates

Tests must turn red for each independent violation:

* equal plaintext pages encrypted before quotienting;
* an explicit zero page or duplicate unique rank;
* noncanonical group partition or capacity padding;
* repeated `(key, nonce)` encryption;
* changed protocol, role, salt, digest, generation, group, slot, class,
  capacity, codec, or extent in AAD;
* corrupted row admitted before its stored authenticator;
* fewer than `k` valid shards accepted, or any valid `k`-subset rejected;
* reconstructed ciphertext not checked by AEAD and canonical digest;
* plaintext promotion to a storage tier;
* a range miss causing full-object retention;
* root publication before all referenced objects are durable;
* non-idempotent root retry or duplicate acknowledgement;
* old supervisor, generation, lease, or incarnation accepted;
* generation or lease wraparound;
* partial cross-page access or reservation leak after trap;
* reclaim by timeout without a durable supervisor fence;
* orphan collection without allocation fence, current root, pinned roots, or
  active intents;
* restore moving the root sequence backward;
* a Worker release retaining clean WebAssembly memory or plaintext pages.

## Current implementation and remaining gaps

Implemented C structure:

| property | implementation |
| --- | --- |
| immutable object digest/extent and canonical rank tree | `artifact/src/object.c`, `artifact/src/index.c` |

The production Worker currently uses browser `PersistentBlock` with WebCrypto
HKDF/AES-GCM and encrypted IndexedDB objects/head. Worker replacement and
browser-restart recovery with approved origin authority are separate tested
behaviors; portable key-loss recovery is not implemented. The object-row/erasure files are still prototypes, not that production
page path. C does not yet implement this complete HKDF/AEAD/erasure/root
admission route, nor all derived lease/arena/recovery policies. Their general
C-only and independent falsification gates remain incomplete; browser encrypted
storage success must not be counted as those proofs.

Remaining normative gaps:

* some opened page-rank and ciphertext directories are dense in logical extent;
* canonical predictor/residual encoding from ARTIFACT.md is not yet the single
  wire representation;
* browser JavaScript still implements ciphertext metadata, admission and
  erasure behavior; the final route leaves it only opaque byte transport and
  WebCrypto calls;
* the 64-bit atomic slot layout, arena retirement, cross-worker reclamation,
  and starvation policy are specified here but are not all implemented in the
  production VM;
* current fixed browser delivery has a digest-pinned descriptor and bounded
  object chunks, not the complete signed canonical release-word projection.
  That broader release-word/Storage publication gate remains incomplete.

Old readers are deleted only after the new canonical artifact reproduces every
logical lookup, every cryptographic admission test, VM parity, and recovery.
The final runtime keeps no compatibility fallback.

## Standards

* NIST SP 800-38D, *Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC*.
* RFC 5869, *HMAC-based Extract-and-Expand Key Derivation Function (HKDF)*.
* FIPS PUB 180-4, *Secure Hash Standard*.
* OASIS, *Virtual I/O Device (VIRTIO) Version 1.3*, for the guest block and network device boundaries.
