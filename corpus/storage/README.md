# Storage primitives

These functions isolate the fixed-width arithmetic in a page delivery path.
They do not define a filesystem or a storage protocol.  Each function is small
enough to compare exhaustively or with dense differential samples.

## Canonical Region

For a fixed immutable base byte `B_i`, the future interface contains singleton
reads at every coordinate.  Two write histories are therefore equivalent if
and only if their final byte is equal at every coordinate.  The persistent
normal form is the exact difference domain

```
D_i = [C_i != B_i]
```

and the final values on that domain.  This is necessary because a singleton
read distinguishes every omitted unequal coordinate, and sufficient because
every coordinate outside `D` is exactly the base.

Let `Q` be the previous dirty domain, `P` the domain of a newer SSA version,
`U` the previous values and `V` the newer values.  Pointwise substitution gives

```
C       = select(P, V, U)
R       = P & (V != B)
D       = R | (~P & Q)
local_i = D_i ? 1 + popcount(D & ((1 << i) - 1)) : 0
slot_i  = local_i ? prefix(block_counts, block(i)) + local_i : 0
```

`R` is constructed only on the write domain, hence `R & ~P = 0`.  The two
terms of `D` are disjoint, so the publication itself is the two-op SSA merge
`D = R XOR ANDN(P, Q)`; recomputing `P & R` or selecting per coordinate is
redundant.  The first equations are the unique right-biased union and its
normalization against the immutable base.  The final two equations are the unique stable
dense address with zero reserved for the base, factored by substitution into
32 independent local blocks and one exclusive prefix of their counts.  The
factorization is exact: the global number of preceding dirty coordinates is
the preceding-block count plus the within-block count.  A separate all-dirty
mode handles rank 256, while empty and full pages require no slot array.

The base comparison domain is smaller still.  Let `E = [V = U]` where an old
dirty value exists.  Since `Q` proves `U != B`, an idempotent overwrite needs
no base observation:

```
A = P & Q & E
T = P & ~A
R = A | (T & (V != B))
D = (Q & ~P) | A | (T & (V != B))
```

`A`, `T`, and `Q & ~P` are disjoint.  `T` is necessary: outside it the answer
is already forced by retained state; at every coordinate in it two immutable
bases consistent with the retained state can make `V != B` differ.  It is
sufficient because observing `B` on `T` fixes every remaining coordinate.
Thus an unchanged dirty write neither fetches the base nor republishes its
dense value.

The scalar C spelling `P ? (V != B) : Q` is normalized before publication.
With `z = V XOR B` and the proved byte range `0 <= z < 256`, substitution gives

```
N = [V != B] = (z + 255) >> 8
D = Q XOR (P AND (Q XOR N))
```

The range proof removes the generic three-instruction `z | -z` nonzero
reduction.  QM verifies all `2^18` inputs and currently lowers the complete
packed scalar boundary to x86-64 BMI2 span 7, work 10.  Once `Q`, `P`, and the
write-domain `R` are already physical SSA nodes, the persistent publication is
still only `D = R XOR ANDN(P, Q)` (span 2, work 2); packed argument extraction
is not part of that internal boundary.

The outer slot rank must not restore a scalar dependency between blocks.
Pack four block counts into nibble fields. Since their exclusive prefixes are
at most `3 * 15`, depositing the fields into byte lanes and multiplying by the
exclusive ones-kernel cannot carry between lanes:

```
offsets4 = PDEP(counts, 0x000F0F0F) * 0x01010100
```

The fourth input nibble cannot affect four exclusive outputs and is substituted
out before search. QM then proves the ordinary C function over all `2^16`
packed inputs and emits `PDEP; IMUL` (span 2, work 2), instead of a 4096-entry
table. A 256-coordinate page composes eight such independent local scans and
a balanced prefix of their group totals; no block waits on block `n - 1`.

## Ciphertext row projection

The storage tiers are not authorities. Memory cache, local persistence, CDN,
and object storage may retain only ciphertext data rows, ciphertext parity
rows, and an authenticated delivery directory. A plaintext page is published
to the resident array only after this order succeeds:

```
stored-row authenticator -> ciphertext reconstruction -> AEAD open
                         -> frame parse -> decompress
                         -> canonical digest/extent
```

Compression must precede encryption, while erasure coding must follow it. Let
`s` be the encoded compressed extent and `q` a projection's authenticated size
quantum. The unique smallest equal-row capacity is

```
class(s)    = ceil(s / q)
capacity(s) = q * class(s)
0 <= capacity(s) - s < q
```

Strictly closing every Reed-Solomon group at a class boundary is not optimal:
an under-filled class pays a complete set of parity rows. Let `a_r` be the
rounded capacity of canonical rank `r`, and stably order ranks by `(a_r, r)`.
For at most `k` data rows, `p` parity rows, an AEAD tag extent `t`, a keyed
stored-row authenticator extent `h`, and group metadata `g`, a consecutive
group has exact cost

```
G(i,j) = (j - i + p) * (a[j - 1] + t + h) + g,  1 <= j-i <= k
F(0)   = 0
F(j)   = min_i (F(i) + G(i,j))
```

Any crossed assignment can be uncrossed without increasing either group
maximum, so a capacity-sorted consecutive optimum always exists. The bounded
min-plus recurrence is therefore exact. It may mix the under-filled tail of
one class with the next class when one extra padding interval costs less than
another complete parity group. The cold result is materialized as direct
`group_of_rank`, `slot_of_rank`, and `capacity_of_group` arrays. Admission is
three array reads, not a hash, search, or dynamic program.

Equal plaintext pages are quotiented before compression and encryption; zero
pages remain implicit. This preserves useful within-object deduplication
without convergent encryption or cross-object equality leakage. A keyed opaque
locator may expose equality inside one volume, but prevents a storage operator
from guessing page content from a public plaintext digest.

Each padded data frame contains its codec, encoded and canonical extents,
canonical page digest, and payload. A fresh data key is required for every
object projection. It is derived by HKDF-SHA-256 from the volume master secret,
a public fresh 256-bit CSPRNG object salt, and the fixed
protocol/role/volume/object/generation context. Root, metadata, locator,
row-authenticator, and row-AEAD keys have distinct length-prefixed role labels.
The object salt is authenticated by the encrypted object metadata and every
row AAD; it is not a secret. A 96-bit nonce is the injective fixed-width map

```
nonce(group, slot) = LE32("ROW1") || LE32(group) || LE16(slot) || 0^16
```

within one fresh object key. Associated data binds protocol and algorithm
versions, object salt and digest, generation, group, slot, capacity class,
capacity, codec, and both extents. A coordinate is claimed before encryption
starts and can be sealed only once in an object generation. A retry resends the
immutable original ciphertext; it never invokes AES-GCM again. The AEAD
ciphertext including its tag is the fixed-width data row; parity is computed
over those ciphertext bytes. Therefore a recovered data row is authenticated
by its original AEAD tag after reconstruction. Before the erasure solve, every
data or parity row is checked by a separate HMAC-SHA-256/128 over
`domain || opaque_locator || stored_row`. This self-authenticating row replaces
a 32-byte digest in the directory with a 16-byte keyed tag beside the row.
The locator key, row-authenticator key, and AEAD key are distinct. Associated
data is reconstructed from the already-opened encrypted directory and is never
published as plaintext metadata beside a storage row.

Recovery matrix inversion is cold publication work. For each bounded
systematic RS geometry, every mask containing exactly `k` available rows maps
directly to a compact ordinal, followed by the `k*k` coefficient block. For the
current `(8,2)` geometry this is a 1,024-entry signed-16 mask array plus 2,880
coefficient bytes, rather than a matrix inverse per page miss. The hot combine
uses the minimized 16-to-8-bit GF(256) artifact inside `vm.wasm`: one vector
call per nonzero source coefficient, no JavaScript byte loop. Its exact 65,536
entry cache materializes only `(source byte, coefficient)` pairs actually
touched and disappears with the worker.

For the current 4 KiB compiler-page population (18,441 nonzero pages), measured
64-byte classes use 59 size classes. Strict class grouping costs 39,356,192
bytes; exact grouping raises padding from 580,140 to 590,828 bytes but removes
54 parity rows and costs 39,252,640 bytes, a net saving of 103,552 bytes. The
same exact calculation gives 39,984,736 bytes at 128 and 41,456,160 bytes at
256, so 64 is the measured default, not a guessed constant. For the nine-page
`vm.wasm`, eliminating under-filled class groups is larger; with 16-byte row
authenticators, 40,096 becomes 21,920 bytes at quantum 64. The exact C class expression
`(encoded_bytes + 63) >> 6` is proved on all `2^16` inputs and lowers to
`ADD; SHR` (span 2, work 2).

## Filesystem root publication

The whole committed filesystem is one immutable authenticated DAG. A root
descriptor does not list every file or page; it has constant extent:

```
object_set_root = H(canonical reachable-object identities)
root_t = H(domain || sequence_t || root_(t-1)
                    || manifest_t || object_set_root_t)
```

The reachable-object list is collector evidence committed by
`object_set_root`; the semantic filesystem state is reached from `manifest`.
Every data row and directory needed by the new manifest is written first. The
root descriptor is then AEAD-sealed and the storage service performs one opaque
compare-and-swap from the exact previous envelope to the new envelope. A loser
leaves only unreachable ciphertext. Repeating the same acknowledged lease is
idempotent; a different payload under that lease is rejected. Encryption and
publication are separate operations: the prepared immutable root envelope is
retained across retries. If the CAS response is lost, reading that exact
envelope as the current head proves success; a retry never creates another
nonce or ciphertext spelling for the same filesystem cut.

Five already-decided facts are necessary and sufficient at the linearization
point: authenticated descriptor, exact parent, next non-wrapping sequence,
live supervisor fence, and a complete durable object set. Packed as the low
five bits `f`, publication readiness is

```
ready = (((f & 31) + 1) >> 5)
```

QM proves all 256 byte inputs and lowers it to `AND; ADD; SHR` (span 3, work
3). This fixed predicate does not scalarize five booleans or branch between
them.

Confidentiality and integrity do not require a trusted storage tier. Strong
consistency does require one minimal ordering fact: the opaque head register
must provide a linearizable conditional write, or an equivalent consensus
witness must do so. If every durable party may maliciously roll back and a
restarted client retains no trusted latest-root witness, freshness is
information-theoretically indistinguishable from an old valid snapshot. The
design therefore trusts no provider with plaintext, but states this ordering
requirement instead of claiming impossible rollback detection.

A public `compiler.wasm` or `vm.wasm` cannot be hidden from the browser user if
its decryption key is shipped with the same public application. The wire shape
still supplies integrity and one admission path, but confidentiality applies
to private VFS state only when its master key comes from the user/session key
boundary and is never stored in local storage, CDN, or object storage.

## Run boundaries

For eight bytes packed in `x`, first substitute

```
d = x ^ (x << 8)
```

Byte `i` of `d` is zero exactly when byte `i` equals its predecessor.  The
lane-local zero test

```
z = ~(((d & 0x7f..7f) + 0x7f..7f) | d) & 0x80..80
```

cannot carry between bytes, so `(~z & 0x80..80) | 0x80` is the complete run
directory.  QM recognizes the neighbor map, uniform zero predicate, and final
affine publication as one `linear-lane-affine` form.

Measured physical results:

| target | span | work | instructions |
| --- | ---: | ---: | --- |
| x86-64 PCLMUL | 7 | 7 | `CLMUL AND ADD ORR NOT AND XOR` |
| Wasm/portable | 9 | 9 | `AND SHL XORR AND ADD ORR NOT AND XOR` |

## Erasure multiplication

Let the carryless product of two bytes be `p = low + x^8 high`.  For the
Reed-Solomon polynomial `x^8 + 0x1d`, substitute `x^8 = 0x1d`:

```
q      = high * 0x1d
result = low ^ (q & 255) ^ ((q >> 8) * 0x1d)
```

The first substitution leaves degree at most ten, so the second fold is
enough.  QM therefore retains one variable carryless multiply and two fixed
carryless multiplies instead of expanding the C loop or constructing a table.

Measured physical results:

| target | span | work | instructions |
| --- | ---: | ---: | --- |
| x86-64 PCLMUL | 7 | 11 | `AND SHR CLMULR AND SHR CLMUL AND SHR CLMUL XORR XORR` |
| Wasm/portable | 17 | 65 | branchless shift/mask/XOR expansion |

The x86 result is verified for all 65,536 input pairs.  The portable result is
still arithmetic and has no 512 KiB lookup table.

## Cryptographic lane

For two 32-bit words, direct substitution gives

```
x1 = ror32(x0, 8) + y0
x2 = x1 ^ key
y1 = rol32(y0, 3) ^ x2
out = (x2 << 32) | y1
```

Keeping the two words as native lanes avoids scalarizing each rotation into
two shifts and an OR.  Every current target lowers this to span 7, work 10:

```
SHR AND ROR32 ADDR AND XOR ROL32 XORR SHL ORR
```

This round only tests the physical add/rotate/XOR form. A storage boundary must
use a complete standard authenticated-encryption construction, not this
function alone. The single delivery order is: quotient canonical pages,
compress and frame each unique page, choose/pad erasure groups, AEAD-seal data
rows, then compute erasure parity over ciphertext plus tag. The object identity
and `(protocol, algorithm, salt, generation, group, slot, class, capacity,
codec)` are associated data. Each key uses a fresh object nonce domain and an
injective row coordinate; a coordinate is encrypted once and retries replay
the same immutable ciphertext. Recovery
precedes AEAD verification; decryption always precedes decompression.
