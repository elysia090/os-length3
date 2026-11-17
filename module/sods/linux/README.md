# Linux execution domain

This crate is the initial internal migration unit for Rust-owned Linux semantics.
It is separate from the x86-64 translator (`../src`) and regular-file payload
storage (`../file-store`). It is not a general-purpose `core` directory.

The private single-action lifecycle and bounded memory-admission table are implemented. It consumes
permission before host execution, retains uncertain completion, accepts cumulative
prefix evidence, and refuses stale/duplicate actions. `Completion::Stopped` requires
both no further effects and ended access; a confirmed byte count alone does not.

The private wasm32 ABI connects that table to `runtime/linux/memory-host.ts`, which
creates and retains actual engine memories without exposing raw memory or callbacks.
Capture/write/grow operations acquire admission before host access. Mutation reserves
exclusively before execution; successful retirement publishes a new binding identity.
Unknown completion keeps the obligation and consumes bounded capacity. A memory
binding is domain-local, not a process identity; ordinary guest writes are not locked.

This is **not yet connected to Linux guest execution or the public runtime**. The
translator import/operator validation, exec/restore/Worker bindings, full domain
allocator and caller migration remain absent. No claim of end-to-end guest lifetime
safety or production TS thinning follows from the adapter. Host artifact checks only
check import/export shape; they do not validate arbitrary module behavior.

Memory/action limits allocate bounded records at initialization. Lookups are bounded
linear scans, O(M + A), not claimed constant-time or optimal. Capture makes one owned
snapshot; write first captures caller bytes then stores them, adding a copy versus a
proved direct source. Grow serializes against active spans. Memory unbind is absent,
so a domain refuses new bindings at its limit rather than growing indefinitely.
Unexpected host exceptions conservatively quarantine the action/binding; no recovery
or automatic retry is claimed. A finished byte count never alone permits release.

A future domain must own exactly one sequence issuer for its unique domain ID.
Each pending operation owns its action and backing/reservation obligations; dropping
this Rust record alone is not permission to release backing. Host callbacks must
not start before `start` succeeds, and a thrown/unknown operation is never reissued.
No completion here proves that other owners or an entire domain can be freed.

Local, dependency-free state tests:

```sh
cargo test --offline --manifest-path module/sods/linux/Cargo.toml
```

These tests do not validate a real Worker, shared-memory observation, browser,
translator artifact, or Linux guest. The next integration must test those actual
boundaries rather than treating this state machine as a usable runtime.

Private ABI integration test with an explicitly built artifact:

```sh
cargo build --offline --target wasm32-unknown-unknown --manifest-path module/sods/linux/Cargo.toml
SODS_LINUX_WASM=<path-to-sods_linux.wasm> node --test module/sods/test/runtime/memory-host.test.ts
```

The real-engine tests cover shared and unshared memory objects, not concurrent guest
writers or cross-Worker visibility. Missing artifact skips those tests explicitly.

## Prepared-root inode ownership (internal)

`inode.rs` now owns directory entries, inode identity and basic metadata while
embedding the existing file-store payload library. Hardlinks share an inode and
one payload. Sizes and lazy-attempt state are queried from that payload owner,
not copied into a mutable Linux shadow. Byte-component names keep the future
Linux boundary independent of UTF-8 path encoding. The payload's standalone Wasm
ABI is disabled for this dependency, but remains enabled for standalone builds.

The builder operates on parent inode plus one component, not guest paths. Each
operation preserves published logical state/input ownership on failure; a whole
mount is not a transaction and failed allocation may leave reserved capacity.
Existing directory modes can update; files/symlinks cannot replace existing names.
Root overlay/origin hydration, permission resolution, guest FD/mapping/Image integration,
source-registry retirement, and Node/muk caller switching are still absent.
The future Rust domain must uniquely allocate Tree owner IDs before connection.

Directory nlink uses 2 plus child directories, matching the current TS Dir.
Lookup is side-effect-free, unlike the old mount has operation that may create
parents. This lookup difference is not presented as transparent legacy compatibility.

Counts bound inode/entry records, not total heap usage. Payload length limits do
not bound total payload bytes or Vec capacity; ownership transfer can retain spare
capacity. Node storage reserves max_inodes initially. Directory hash indexing avoids the
previous unconditional quadratic sibling scans: expected construction is O(B + N)
for N entries and B name bytes, with O(B + N) retained name/entry storage. Reservation
and name allocation precede payload acquisition; publication does not allocate.
These are expected hash-table costs, not adversarial worst-case guarantees. The
Wasm target's RandomState entropy strength is not established; colliding names can
still cause quadratic work within admission limits. No directory enumeration API
is provided here. Legacy getdents sorts names and resumes after the last name, not
insertion order; its sort cost and string-versus-byte ordering need separate review.
This is a semantic migration unit, not an optimized or usable Linux replacement.

## Descriptor ownership (internal)

`descriptor.rs` keeps prepared Tree storage, open descriptions and descriptor
tables in one Rust owner. The Tree cannot be taken out or individually disposed
while its descriptions remain. This owner is not a Kernel: PID/IPC, credentials,
mount namespaces and process termination decisions do not belong here.

FD numbers are reusable positions in a table, not description identities. Separate
opens have separate offsets; dup and a copied table share a description and its
offset revision. A shared table has independent holder accounting. CLOEXEC belongs
to its slot rather than the shared description. Internal handles must reject stale
or foreign generations; exhaustion must not wrap them into an old identity.

These operations do not implement guest open/openat, permission checks, mounted
path resolution, console/pipe/socket finalizers, pending reads or memory copies.
Closing the last description does not reclaim its inode payload: namespace,
mapping, image and source ownership still need the full migration. The Node and
muk callers continue using the existing TS runtime; no production TS deletion is
claimed for this internal stage.

Tables use sparse maps rather than allocating the full FD-number limit. Limits
cover table/description record counts and total live slots, not exact allocated
bytes: Vec and HashMap spare capacity can exceed live counts and is retained.
Fork copies live slots and aggregates all reference increments before publication,
but map iteration scans retained capacity; expected work is O(source capacity +
live slots), plus the table arena scan. It also reserves a temporary count map
for up to the live-slot count. Lowest-free FD search can scan to the table limit;
open admission scans the description arena. These gaps from the necessary
O(live slots) fork work are explicit, not claimed optimal.

Table holder tickets are non-Copy/non-Clone; share creates a ticket and let_go
consumes it. Dropping a ticket without let_go retains the table until Files drops.
The embedding must allocate unique owner incarnations and retire all tickets.
Neither a Rust handle nor a guest FD number alone proves an external operation
has stopped. Pending read references and offset commit after copy receipts must
be integrated before asynchronous access can safely use this owner.

Passing a holder to the wrong Files rejects it but consumes that ticket, retaining
its original table. This is an internal misuse limitation, not a public recovery
contract; a public release API must preserve recoverability before exposure.
