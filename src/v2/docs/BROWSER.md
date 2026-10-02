# Browser projection of OS Length3 Linux

## Fixed input and success condition

The input is the published native candidate, not the historical machine pack:

```
release       os-length3-linux-v0.1.0-rc.1
publication   1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195
bundle.sha256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

Keep the native asset and its receipts unchanged. A browser projection must
be built from an authenticated extraction of that asset, preserve its files,
hard links, permissions, kernel, initramfs, package state and service graph,
and name the source publication in its own authenticated root. Derived module
or block-device boundaries are not a second Linux release.

Boot is a necessary gate, not the product success condition. Real browser boot
through the included Linux kernel and PID 1 must lead to offline shell, C
compile/link/run, `make -j4`, local Git and package queries. Beyond that, the
workspace must use browser-reachable storage, networking and file exchange
without becoming a second OS or requiring a local native helper. The resource
and acceptance contracts below are part of success, not optional decorations.
No QEMU process, server-side execution or JavaScript POSIX/x86 implementation
can make this gate green. Measure cold acquisition, validation,
compile/instantiate, first prompt, fetch count, resident high-water mark and
reopen separately. The three-second cold prompt is a target, not a result.

## Mental model: a workspace with connections, not a simulated PC

The ordinary user opens a **workspace** and connects resources to it. Linux
keeps ordinary files, processes, sockets and devices. The browser is the
resource/consent boundary, not a POSIX implementation. A virtual device is
only the guest-facing projection of a connection; it is not the product model.
Editor, Run, Files and Terminal remain the existing work surfaces; connections
and status belong within that workspace, not new competing Playground/System
entry points. This contract does not require a human-UI layout redesign.

Three lifetimes must not be conflated:

```
workspace:  release + current system root + committed project/config root
connection: workspace + resource + authority scope + grant revision + limits
machine:    workspace + execution generation + resumable architectural cut
```

The filesystem head binds the system and workspace roots atomically as in
STORAGE.md; the components are not independently published half-transactions.
Changing the machine does not copy or rename the workspace. Changing a cache
tier does not change a root. Remembering a connection preference does not
restore a revoked browser permission. A reopened machine rechecks actual
permission and receives new generation-bound operation tickets.

Effective access is the intersection, never the union, of:

```
browser consent / deployment policy
    AND explicit workspace grant
    AND implemented adapter capability
    AND Linux's ordinary guest permissions
```

The host broker owns browser handles, transport sessions and user gestures.
The C boundary admits only scoped, bounded operations and rejects stale replies.
Storage then authenticates/decrypts/reconstructs extents before residence;
Linux owns the resulting filesystem and network semantics. A transport ACK is
not a storage authentication proof or a root publication receipt.

Fetching public release objects is delivery, not a guest network grant. A
storage connection authorizes only its declared object service/prefix; it does
not authorize arbitrary URLs chosen by the guest or locator metadata. The NIC
grant separately governs guest egress/ingress. These are different resource
roles over one host network, not two implementations of guest sockets.

```
browser storage / chosen files / network gateway / serial port
                         |
                 consent + host handles
                         |
                scoped bounded operation
                         |
                C resource admission gate
                         |
               Storage / machine devices
                         |
                  real guest Linux
                         |
             cc, make, git, curl, files, tty
```

"Beyond QEMU" means less configuration and better resource composition:
page-sized authenticated acquisition, encrypted multi-tier persistence,
cheap workspace branching, scoped host file exchange and revocable connections
with observable status. It is not a claim of a superset of QEMU's ISA/device
support, faster CPU execution, raw browser sockets, or unlimited host access.
QEMU already separates guest devices from host backends and supports COW images,
network backends and snapshots. Those features are not inventions here. The
additional product obligation is browser-first consent, identity-preserving
page delivery and workspace lifecycle with measurable acquisition/residency
cost, without an installed local hypervisor. Compare concrete workflows and
budgets, not the number of API names or an unmeasured superiority label.

## Browser resource surface

| Connection / facility | Browser use and guest projection | Mandatory boundary |
| --- | --- | --- |
| Managed workspace storage | Memory working set, OPFS/IndexedDB/Cache cache, and granted remote object stores supply the same authenticated extents to guest block devices | Managed persistent tiers receive ciphertext. Cache contents, quota and eviction are untrusted; Linux remains the VFS. No complete disk/root reconstruction to touch one page. |
| Selected local files / directories | File picker, drag/drop and downloads exchange files with an ordinary guest directory through explicit import/export | File handles stay in the host broker. External names are transfer metadata, not a second guest pathname resolver. C/guest code validates names and Linux performs creation/copy. No writable live mount until exact filesystem/concurrency semantics are implemented. A plaintext export is an intentional disclosure, not managed encrypted storage. |
| Granted network | One virtual NIC uses WebTransport datagrams to an origin-authorized packet gateway; Linux runs DNS/TCP/UDP/TLS/SSH | Require a negotiated datagram-capable transport. A bounded below-IP frame bridge handles smaller datagram budgets without violating IPv6's guest link MTU. Do not silently use reliable-only streams, fetch sockets or private routes. |
| Published guest service | A separate scoped ingress grant gives a running guest server a usable browser URL through the network route | Never expose every guest port. Expiry/revocation, origin/authentication and any external HTTPS preview proxy's TLS termination are explicit. It is not a JS server executing guest code. |
| Terminal / clipboard | Ordinary guest tty plus user-initiated paste/copy and file download/open | User gestures and browser policy are required where applicable. No background clipboard polling, injected host PATH, or implicit host file access. |
| Serial / other selected devices | Web Serial may back a declared guest console channel; USB/HID/media/GPU are separately probed optional adapters | API existence is not permission or an implemented Linux device. Unsupported adapters remain visibly unavailable rather than selecting an alternate interpreter or faking a driver. |
| Offline shell / delivery | Service Worker may cache authenticated delivery and the UI; Web Locks may coordinate local tab ownership | Neither is a durable filesystem authority, distributed root CAS or immortal VM scheduler. The shell's service DAG does not wait for network/time sync or a persistence prompt. |

File picker, clipboard and device grants originate in the window/user action;
VM, OPFS synchronous I/O and transport batching run in suitable dedicated
Workers. Optional capabilities are reported separately as unsupported,
available-but-not-granted, connected, suspended or failed. A boolean feature
test cannot label a capability "connected". No permission prompt is triggered
merely by booting or inspecting status.

### Persistence means receipts, not a successful local write

```
dirty machine pages -> staged encrypted objects -> durability receipts
                    -> authenticated compare-and-swap filesystem head
```

Local staging may make reopening fast, but is not evidence of remote durability.
`navigator.storage.persist()` is a browser retention request, not a replication
receipt. The workspace declares which stores/receipts make a commit durable.
An offline volatile workspace may run normally; it must identify unsaved or
locally staged changes and support explicit export rather than promise cloud
recovery. When commit fails, normal close cannot discard the only dirty copy.
Forced browser termination can still lose unacknowledged data; do not hide that
availability limit behind encryption, ECC, a Service Worker or the word "cache".

Two tabs can share immutable objects immediately. Writable ownership uses the
fenced lease/root publication protocol; absence of that authority means a
read-only view or an explicit branch, not two independent writable heads.
Web Locks can coordinate one origin but cannot fence a different device or
replace the durable root authority. Reconnect must report a conflict instead
of overwriting the other branch.

### One control boundary, independent from execution

Each in-flight host batch binds the full authority/workspace/resource/lane tuple,
machine generation, grant revision and monotonically issued sequence. Revocation,
rebind, cancellation and Worker disposal fence completion before any payload
can enter guest state. Counters never wrap into an old ticket: exhaustion fails
closed and needs a fresh authority scope. A revoked operation already delivered
to an external system cannot be undone; immutable writes and root fencing limit
the effect, while user-facing status must not pretend otherwise.

A random nonce is not a proof of unlimited uniqueness. Authority scope
acquisition must be fenced or collision-checked with the old-ticket lifetime
included in its reuse rule. If non-reuse cannot be established, fail closed;
do not restore a counter to zero under the same address. Grant binding is a
privileged supervisor operation, never an import offered to a guest module.

The C gate is serialized by the owning supervisor. Other Workers exchange
messages, not direct mutable access to its grant cells. One cell represents one
bounded in-flight batch lane, so independent lanes can progress concurrently;
neither one promise per guest instruction/page nor a global serialized guest
I/O loop is required. Native adapters use the same policy boundary. The gate
does not authenticate payloads or manufacture browser consent, and does not
defend against a compromised same-origin host broker that is part of the TCB.

The current implementation is `vm/core/resource.c`. `make -C src/v2/vm check`
tests 100,000 range/direction cases plus scope, rebind, revoke, duplicate reply,
cancellation and exhaustion boundaries. A two-lane witness first reproduced
cross-admission of equal per-lane sequences; explicit lane rank in the ticket
address removes that alias without a global sequence counter or reply search.
Native ASan/UBSan also pass. It has
no heap, payload copy or object-sized directory. Browser handle binding and
compiled machine/device integration are still pending; this is a control-policy
checkpoint, not a Linux boot or storage durability result.
One API-to-linear-memory transfer may still be required by the browser. Measure
it; do not claim zero-copy for every API or hide duplicate object-sized copies
behind a Worker. Batching and transferable opaque buffers avoid per-instruction
host calls; shared memory is a separately admitted optimization.

## Product acceptance beyond boot

All mandatory rows must pass against the shipped bundle in a real browser.
Optional browser facilities have explicit unavailable/denied tests, not fake
green implementations. Report each gate separately; a fixture does not pass it.

| Gate | Observable acceptance |
| --- | --- |
| Linux development | Boot -> offline shell -> C compile/run -> `make -j4` -> local Git/apk/archive operations through the same release kernel; no runtime execution fallback. |
| Page-native storage | Open/modify/sync/reopen an actual guest workspace; record fetched/authenticated/dirty bytes. A one-page access never reads the full root. Corrupt/missing cache entries refetch or fail explicitly; no zero-fill or plaintext promotion. |
| Persistence and branching | Quota denial, local cache loss, remote unavailability and a crash during head publish preserve the prior committed root. A second tab/device cannot accept an old owner ACK; explicit branches preserve project changes. |
| Browser file exchange | Import an actual selected source tree, build it, export the result, revoke the connection and deny subsequent access. Test cancellation, stale handles, name traversal and interrupted export. File/download fallback is declared when directory picking is unavailable. |
| Network | Granted DNS, certificate-verified curl/Git HTTPS and SSH; denial/expiry/revocation, private-address rejection, packet loss/MTU, reconnect and bounded ingress. No network grant is needed for an offline prompt. |
| Browser-accessible service | Build/run a guest server, publish only its chosen port, open the resulting URL, then revoke it and demonstrate that new access fails. Record any proxy trust boundary rather than claiming end-to-end guest TLS. |
| Resource lifetime | Exact suspend/resume, committed close/open, old/duplicate replies, reservation cancellation, clean-module/page eviction and Worker restart without stale publication. Measure memory separately; no automatic RSS claim. |
| Introspection / optional devices | Status exposes release/root, unsaved/staged/durable state, connections, denied permissions, resource/fetch budgets and errors without guest debugging. Selected serial/clipboard and other supported adapters have their own permission and revoke checks. |

A single runnable download still needs an HTTPS origin and, for external
networking/remote durability, explicitly configured services. Publish those
deployment requirements and negotiation failures; do not bury them in a VM
launch script or imply the native root bundle already supplies a public gateway.

## Constraints determine the physical boundary

| Constraint | Required arrangement |
| --- | --- |
| x86 addresses are 64-bit; wasm32 offsets are not | Keep architectural addresses as `i64`. C MMU/physical-page admission returns bounded arena offsets. Never cast guest pointers to host offsets. Memory64 is not a baseline dependency. |
| Linear memory can grow but has no shrink operation | Use bounded worker-owned arenas. Clear reconstruction caches, checkpoint the complete dirty machine cut, then terminate the owning Worker. Logical page release is not evidence that the engine reclaimed RSS. |
| A long synchronous Wasm call blocks its Worker | Export bounded cut-to-cut execution. Return an event/fault/resource token with no live Wasm operand stack; await opaque I/O outside the call and resume the same cut. Guest calls/stacks remain guest state. No Asyncify or JS instruction loop is required. |
| Browser code generation has finite module/table budgets | Emit independently authenticated bounded modules. Reuse one machine memory/table per Worker, reserve slots transactionally and clear cold slots before dropping instances. Do not emit one distribution-sized module. |
| Shared memory requires cross-origin isolation | Start with one vCPU/one Worker and ordinary memory; Linux still schedules all guest processes. Admit shared-memory execution only after a real COOP/COEP/Permissions-Policy probe. No missing feature may select a different CPU implementation. |
| Streaming compilation requires Wasm MIME and compatible CSP | Serve `application/wasm` and allow only `wasm-unsafe-eval`, not general `unsafe-eval`. Authenticate immutable module bytes before instantiation/execution. Streaming compile of unauthenticated bytes is not admission. |
| A normal `.tar.zst` is not a random-access block device | Authenticate/extract on the publication side, then derive bounded independently authenticated delivery extents from the same root. The browser fetches that projection, not both the native tar and a second complete root. Do not expand the tar into a browser-owned pathname filesystem. |
| Browser caches can be evicted or unavailable | Treat them as untrusted optional tiers. Bounded in-memory working state and authenticated roots are sufficient to operate; a miss can refetch, not silently supply zero bytes. No storage permission dialog blocks offline shell readiness after required bytes arrive. |
| Browser fetch is not a guest socket | Keep Linux's stack and virtual NIC. Add an explicitly granted WebTransport gateway after offline boot. CORS, CSP and secure-context failures are deployment errors, never a reason to implement guest HTTPS in JS. |
| Timer/background throttling is not guest CPU time | Yield by bounded cuts, report host suspension, and inject clock/interrupt events through the machine ABI. Do not promise an exact background schedule or pretend a terminated Worker retained a live process. |

SIMD, multiple memories, shared memory, OPFS and memory64 are optional measured
capabilities. The x86 CPU contract still comes from `x86/profile.h`; a browser's
host CPU or SIMD availability must not change guest CPUID, flags, faults,
floating-point rounding/NaNs or memory ordering.

`suspend` retains dirty guest RAM (including anonymous heap and stacks), vCPU,
MMU-relevant cut, device/virtqueue/interrupt/timer state and generation, while
discarding reconstructible clean pages. It resumes exact execution. `close`
commits workspace/config roots and discards the machine; `open` cold-boots the
same release. Workspace pages alone cannot resume an existing shell process.
The supervisor must stop/fence the old Worker before reclaiming reservations;
stale and duplicate acknowledgements never advance a newer generation.

## Current gaps, not browser limitations

Inspection on 2026-10-02 found:

* `wasm-compiler` now directly emits bounded pure register cuts from the
  accepted executable segments. Native/Node execution comparison covers 77
  actual generated modules and 39,424 cases, including a three-instruction
  prefix of the shipped BusyBox entry. Whole-image function/control/dispatcher
  closure still returns `WASM_COMPILER_ERROR_INCOMPLETE`; these small cuts are
  not a Linux execution backend. The CLI is built by `all`.
* Compiled machine execution, MMU and virtio devices in the new VM product
  are not implemented; the retained `vm/wasm` and `web/vm.js` code still contains
  historical execution machinery. A tested resource gate alone is not a VM.
* `linux-worker.js` defaults to `linux-x86-64-machine`, which is absent from
  the current catalog and is not the shipped bundle. Re-enabling that old
  catalog entry would not test this release.
* A bzImage includes boot/decompression code and is not just an ELF function.
  Kernel startup, physical/virtual aliases, alternatives/relocation and precise
  instruction faults require an explicit compiled machine/boot boundary.
* `cc`/`as`/`ld`, `exec`, runtime code patching and executable mappings generate
  new code. Before claiming development acceptance, define a compile-admission
  transaction for each executable generation. Compile the accepted x86 bytes
  outside execution, bind load/CPU/patch context, publish only complete Wasm
  coverage, then invalidate stale code on writes. Do not require every future
  user program to have been enumerated in this release or silently interpret it.
* The C Artifact release publisher, storage authentication/recovery and NIC
  implementations have remaining gaps documented in ARTIFACT/STORAGE/NETWORK.

## Implementation order

1. Make these gaps executable red gates: build the Wasm CLI, require it to
   produce valid executable Wasm from a real optimized ELF, and probe the
   actual browser Worker/memory/table/CSP/Range boundary. Capability success
   must never be labeled Linux boot success.
2. Implement the optimized-x86-to-Wasm compiler over accepted executable
   segments, with complete direct/indirect coordinates and exact fault cuts.
   Decoding belongs to this cold compiler, not VM execution; native post-link
   optimization remains independent. Keep unsupported transfer families red.
3. Bring up C VM state/MMU/devices and bounded dispatch; compare generated
   modules with native/QEMU oracles before admitting the kernel startup cut.
4. Publish bounded authenticated code and read-only block supply from the
   same bundle. Connect offline boot/terminal first; then executable-generation
   admission, C/make/Git and workspace lifecycle.
5. Connect encrypted managed storage, explicit file exchange, granted networking
   and service publication; pass the product gates above. Add shared workers
   only when their measured benefit exceeds synchronization and residency cost.
   The offline boot dependency remains independent of network readiness.

The diagnostic page is `vm/check/browser/index.html`, not a replacement for
the human UI. `node data/oracle/serve-browser.mjs` serves it on loopback with
MIME, byte ranges and a restrictive CSP; `--isolated` additionally enables
COOP/COEP. Probe both arrangements. Tests use tiny Wasm fixtures and do not
allocate gigabytes merely to discover a browser's failure limit.

The [2026-10-02 manual browser result](../vm/check/browser/evidence/README.md)
passes with ordinary memory and no isolation: two fresh Worker generations,
64-bit value transport, memory growth, table-slot clearing and an eight-byte
HTTP 206 response. This supports the single-Worker baseline. Linux boot, RSS
reclamation and the isolated-browser configuration remain unverified.

## Platform sources

* [WebAssembly memory growth](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow)
* [Cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
* [Streaming instantiation and CSP](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static)
* [Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
* [WebTransport datagrams](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/datagrams)
* [WebTransport reliability negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)
* [OPFS synchronous access in dedicated Workers](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle)
* [Persistence requests](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
* [Directory picking and user activation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
* [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
* [Service Worker lifetime](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
* [Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)
* [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
* [QEMU device/backend separation](https://www.qemu.org/docs/master/system/device-emulation.html)
* [QEMU disk images and snapshots](https://www.qemu.org/docs/master/system/images.html)
* [QEMU network backends](https://www.qemu.org/docs/master/system/devices/net.html)
