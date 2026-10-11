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

The ordinary PID1-supervised console starts after positive API-filesystem,
root, credential and installed-program prerequisites; it is not a shell
launched by a failure handler. `console-ready` and completed
`interactive-ready` service state are separate observations. Auxiliary s6
initialization still exceeds its unchanged ten-second guard.

The ordinary console passes C compile/link/run, four independent targets
under `make -j4` and unchanged-ELF incremental rebuild checks, Git init/add/commit, musl
package inspection (not installation/dependency resolution) and Linux sync
(`product-development:pass`). A
Linux-created `/workspace/browser-proof/keep.txt` survives flush, Worker
termination and a new Linux cold boot (`storage-restore:pass`). The saved
ELF also runs after reopening (`product-linux-ok`). Guest RAM/process resume
is not claimed, and guest writeback must be synced before closing.
The expanded [userland acceptance](2026-10-11-userland-acceptance.md) separates
these results from pending exact per-target receipts, package transactions,
permissions, terminal/job control and the larger restart population.

The granted C NIC is Linux eth0. The actual browser passes DNS/TCP and
certificate-verified TLS 1.3 with explicit `--curves X25519` to kernel.org:
OpenSSL verify result 0, hostname match, HTTP 200, curl exit 0 and exact
19137-byte HTML containing the expected Linux Kernel text. The conditional
marker is `certificate-verified-kernel-https:pass`.
Default hybrid TLS to example.com and a separate TLS 1.2 probe still fail
with peer EOF; these are not counted as success or hidden by the working
X25519 probe. Investigate expensive crypto/peer timing separately.

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

The generated offline service database has exactly the same dependency
closure as `boot-offline` in the full graph. The full graph remains installed
and is activated before network services. Safety guards stay at ten seconds.
The corresponding native root passes the same PID1/development commands at
1169.2 ms ready. Browser readiness must be measured independently.

The loopback WebTransport gateway accepts a granted Ethernet link without
guest TCP/TLS implementation. Windows explicitly uses a SHA-pinned official
libslirp 4.9.3 backend with full-width sockets; a real ARP response passes.
Linux TAP remains another explicitly authorized host resource. Neither is a
product CPU or an implicit interpreter fallback.

## Additional independent observations

All C/ASan/UBSan gates pass with source SHA256
`870df80f4b724101f94fb8537c2e60c1113d80212c9229b11f49b5eee56ce0f3`
(246846 ms in the independent official Linux oracle). Read/write/fetch
observations no longer evict each other merely for using one virtual page;
100000 alternating accesses retain both exact witnesses at the same capacity.
Actual browser walk misses fall to about 2.1 million / 136.9 million
observations during startup, compared with the earlier approximately 13%
miss ratio. These are different startup prefixes, not a paired end-to-end
speedup claim.

Worker scheduling has an eight-millisecond host task opportunity at completed
C cuts/quantums. Resolved-Promise chains cannot monopolize input, network and
close messages. A privately owned MessageChannel task, not a throttled timer,
implements that opportunity and is disposed on close. This does not alter
guest time, deadlines, retirement or DMA ownership. Deterministic, real-task,
concurrent-refusal and pending-close scheduling regressions pass.

The SHA-pinned libslirp backend passes real upstream DNS (not only ARP).
The same kernel/root also passes raw DNS datagram, libc getaddrinfo and
certificate-verified curl HTTPS under the independent QEMU/WHPX microvm
oracle (`oracle-native-https`, `oracle-system-command: 42`). An earlier oracle
misconfiguration assigned the NIC subnet to loopback and stole its route;
the loopback parsing witness now uses an unrelated /32. It was not a kernel
or post-link failure.

The current `browser-single-worker-1011b` candidate uses one compiled service database. Offline/network readiness
changes service state, not the running database or live service directories.
The failed intermediate boot/full database-switch path is removed.
The DHCP privilege-separation account and bounded BusyBox ping options are
now explicit recipe inputs. Network readiness requires an actual address,
default route and resolver, not merely a live DHCP process.

Its release SHA256 is
`c588c7920ecec616ae9311ed009353b321007b95bc63814242cdfd1e3532cdd9`.
All five role payloads are owned once; other release roles hardlink that owner.
The publisher streams/hash-writes one private inode, verifies the producer
did not change, flushes it and links the immutable digest coordinate. It does
not hash one producer read and copy a second potentially different read.
The ten-role/two-release ownership test retains one inode and no staging files.
A caught partial producer snapshot was quarantined without publishing a root.

The new-volume browser check formats ext4 UUID
`bff944ab-dacd-47b9-8d1b-81f29137695a`, writes and syncs an exact test value,
closes/flushed the Worker and cold-reopens without formatting again.
`fresh-storage-restore:pass` is conditional on content equality, followed by
SHA256 `79846ab72c6cb7c39566a7c27ff211ba8c70abd29cd811aef176d499e2d7bb3f`.
The older-volume text and saved ELF restoration remain separate checks.

The independent CPU wired to the SAME host packet backend exposed a Windows
TCP polling failure after ClientHello/payload ACK, despite successful DNS.
The corrected full-width select backend passes native guest HTTPS
(`native-select-nat.log`), while direct host HTTPS is a separate test.
The browser passed the X25519 HTTPS witness against that corrected gateway,
not a guest network implementation or different CPU engine. The saved
screenshots show actual TLS verification and HTTP 200, not a probe echo.
