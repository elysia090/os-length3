# Product Worker devices and persistent blocks

The product Worker and startup diagnostic share `machine-runtime.mjs` and
the C CPU, MMU, source dispatcher and devices. Linux owns filesystem, process,
signal, socket and time semantics. The legacy Linux executor and 1478 lines
of unused DirectX86Machine helpers are removed; the playground is unchanged.

## Actual browser evidence

The rebuilt Linux 7.2.7 kernel recognizes the C virtio block device `/dev/vda`.
The packaged static PIE mke2fs creates ext4 on a 256 MiB sparse encrypted
volume. Linux mounts it as the OverlayFS upper backing. FLUSH publishes an
authenticated root. Closing and recreating the production Worker remounts
the same UUID and performs Linux journal recovery, without formatting again.
The main-thread supervisor retains the key and exact pinned root between
Workers; losing that authority is not equivalent to recovering from storage.

The current ordinary service startup still exceeds its unchanged ten-second
s6 guard. No rescue shell satisfies this gate. Guest HTTPS is also unverified.
The earlier successful rescue C, make-j4, Git and tar results are separate.

## Physical boundaries

MMIO has one C transaction, no RAM payload slot, and no read-for-ownership.
Physical DMA preflights the complete extent and rechecks generation before
publishing a used ring. The net/block resource ticket binds authority,
workspace, resource, generation, revision, lane and sequence. Reset, revoked
grants and stale completions cannot replay guest DMA.

With no EVENT_IDX or NO_NOTIFY suppression, the standard driver kicks new
work. No notification and no in-flight request eliminates empty ring reads.
100000 empty polls preserve the C poll counter. PTE witnesses use exact
before-write invalidation, including DMA and A/D; cache hits no longer reload
four paging ancestors. Foreign writes must notify before mutation. Directory
ownership and serialization remain preconditions, not an SMP lease claim.

Virtual aliases of one physical code extent share its origin-independent
body. The virtual PC remains an execution binding. 100000 aliases share one
source rank; byte/extent/instruction/literal equality passes 954006 C compiler
comparisons across user/kernel origins using the unchanged 476838-record
input population. This is an origin-invariance gate, not universal ISA proof.

## Independent checks

All C and sanitizer gates pass in the official isolated Linux oracle with
source SHA256 `e082389acba5aa7fb4d3afc372c0aa1dd2732729bb1e3f0f6d70b314e6681242`.
The corrected MMU fixture first exposed a stack-use-after-scope in an old
observer; reset now ends that lifetime before constructing the next case.
Source identity, generation, fault and mutation checks remain in the suite.

The same rebuilt kernel/root passes independent native PID1/offline service
checks, C/link/run, make-j4, Git, AES and apk at 4466.1 ms ready. This number is
native QEMU/WHPX oracle timing, not browser cold readiness.

The loopback WebTransport gateway accepts a granted Ethernet link without
guest TCP/TLS implementation. Windows explicitly uses a SHA-pinned official
libslirp 4.9.3 backend with full-width sockets; a real ARP response passes.
Linux TAP remains another explicitly authorized host resource. Neither is a
product CPU or an implicit interpreter fallback.
