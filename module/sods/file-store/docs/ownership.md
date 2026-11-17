# File-store ownership

## Scope of the implemented contract

Rust owns canonical payload bytes, lazy source/attempt state and the outstanding
read-copy lease. TS owns host callbacks and adapts File/Vfs/mapping behavior. Linux
process/FD/namespace state, Worker lifecycle and guest memory are not migrated into
this store. A payload handle is not a guest fd and raw Wasm exports are not a safe
embedding API.

`loadFileScope` owns every created payload until explicit disposal. Its creation
policy is opt-in; existing files and default Vfs are not converted. A sole finite
caller may dispose only after all consumers have ended and no more use of their
File/Vfs/Image graph will occur. Long-lived default promotion remains withheld.

## Payload and operation rules

- IDs are monotonic and never reused within a store. Closed entries leave the live
  index, but its capacity, scratch capacity and Wasm linear memory may remain.
- A lazy source has one active load attempt. Matching completion or failure retires
  that attempt. Same-inode reentry poisons it, even if the callback swallows the
  nested error. Independent later retries and other-inode operations are distinct.
- Source callback identity is not a TS cache of Rust readiness. Closing removes
  the callback capability; stale completion cannot resurrect a closed payload.
- Input bytes are captured before input scratch publication. Reload publication may
  transfer scratch ownership where capacity constraints permit; that is not a
  zero-copy guarantee or proof of reduced total memory traffic.
- Read scratch has one lease through matching copied/unknown completion. No host
  callback or escaping scratch view crosses the copy window. A copy failure retires
  the lease without claiming rollback of already-visible writes.
- Readiness is rechecked after the caller's ready callback. Release/reload, close,
  mutation and callback failure must not be hidden by a cached ready flag.
- Successful data snapshots belong to the caller and remain valid after scope
  disposal. File objects and other raw graph references do not become independent.

## Owners outside the Rust payload

| Owner | What must finish or be transferred |
| --- | --- |
| Unpublished creation | Publish once or abort once; publication followed by failure is not necessarily rollback |
| Namespace entries and hardlinks | All actual directory/mount edges, not just nlink |
| Descriptions and queued SCM_RIGHTS | Every shared/inherited/in-flight description owner |
| Shared mappings | Publication/writeback or explicitly failed retirement; split transitions cannot create a false zero-owner gap |
| Image, source and translation observer | Active execution, deferred sources, cached/pooled instances and observation callbacks |
| Host operation and Worker | Registered operations, accepted output and positive host-stop evidence; cancellation requests alone are insufficient |
| Raw embedding access | Explicit caller lifetime promise; counters cannot enumerate arbitrary escaped mutable aliases |

Mapped payloads remain resident so writeback does not invoke an arbitrary loader.
Dirty runs retain ordered capture → own → write → show semantics. An earlier
accepted run survives a later failure. Whole-page replacement or batch gathering
cannot erase another mapping's independently modified bytes. Alias/copy/scan costs
are documented separately in [costs.md](costs.md).

## Finite independent Node caller

The independent sods package acceptance test owns one scope and Kernel, with no
rehearsal, passOn or external raw-graph users. It checks guest completion (zero and
nonzero exit), result snapshot/sink acknowledgement, and positive stop evidence
for all observed adopted Node Workers separately. The remaining Worker snapshot
can be empty because already-stopped owners were retired; empty alone is not proof.
Only after these gates does the caller explicitly dispose the scope.

Sink write/readback is not fsync durability. Injected missing acknowledgement,
missing evidence and unresolved preparation cases retain their scope/Kernel. Those
injections occur after real host shutdown; they do not reproduce an unkillable
Worker. Browser termination guarantees and automatic shared-tree reclamation are
not established by this test.

## Runtime failure boundaries and unresolved work

The Linux adapter/runtime has additional safeguards independent of the store:

- Pending reads validate process/image/memory generation, descriptor offset and
  post-loader identity before copying. Successful copy completion precedes offset
  commit. Scatter and transfer callers have their own partial-effect contracts.
- Loader preparation precedes destructive write/truncate/mapping steps where
  implemented. A denied operation must not silently lose already-dirty bytes.
- Process/Task metadata is prepared before acquiring avoidable FD/Fs/PID/channel
  owners. PID registration/publication checks preserve the original error and do
  not reuse consumed IDs or declare a failed namespace init alive.
- A failed new child instance is cleaned up only with unexposed ownership proof.
  The actual x87 allocator/handle is captured, shared memory returns only its extra
  reference, and private failed memory is discarded rather than pooled.
- A returned load can already be reachable, partially published or scheduled. Later
  failure retains Task/acquisition evidence with no invented stop, dead state or
  rollback. Original errors remain original; an errno can coexist with prior effects.
- Failed preparation roots block tree/global-reference release. Each resource is
  not-attempted, returned or uncertain; uncertain evidence authorizes no cleanup retry.

Pre-load allocation/constructor failures, safe recovery of retained partial-fork
owners and general long-lived disposal remain open. Ordinary standard failures
matter; complete transactional rollback of arbitrary raw getters or Map overrides
is not a substitute for a closed ownership contract. Repeated failures can retain
additional resources. Taint is not proof that unknown readers have stopped.

## Regression entry points

Current tests under `module/sods/test/runtime/` include `file-store.test.ts`,
`file-store-loading.test.ts`, `file-scope.test.ts`, `file-scope-creation.test.ts`,
`file-scope-lifetime.test.ts`, `file-scope-publication.test.ts`,
`read-lifetime.test.ts`, `fork-preparation.test.ts`, `pid-preparation.test.ts`,
`process-retirement.test.ts`, `mount-retirement.test.ts` and Worker-stop suites.
The ricebox private lifecycle tests remain in ricebox; their protocol is not a
sods-wide resource manager. Historical investigation and intermediate limits are
available in Git history. These notes describe the current contract, not a claim
that every proposed transition has been implemented.
