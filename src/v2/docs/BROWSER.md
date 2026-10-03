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
  accepted executable segments. Native/Node execution comparison covers 83
  actual generated modules and 42,496 cases, including a three-instruction
  prefix of the shipped BusyBox entry. Whole-image function/control/dispatcher
  closure still returns `WASM_COMPILER_ERROR_INCOMPLETE`; these small cuts are
  not a Linux execution backend. CLC/STC and CLD/STD join the pure flag frontier;
  CMC/ADC/CMOV and STI remain unsupported. SETcc interior flag consumers now
  use the common backward read/kill frontier. CLI has a
  precise long-mode, non-PVI/non-VM cut; pending faults are not exception entry.
  Register-source segment loads now use the C GDT/LDT/cache boundary, with a
  versioned architectural companion and MOV SS shadow. The actual shipped
  startup now retires 378 source instructions to `0x1000281` in a real browser
  Worker and Node/C-Wasm. Memory RMW, LGDT/LIDT and same-CPL long-mode far RET
  and general control-register reads/writes, memory CMP/TEST, register SHL/SHR/SAR
  and all 16 register SETcc conditions are admitted. Fixed-profile CPUID and
  16/64-bit stack flags transfers also pass their independent matrices. REP MOVS
  now uses the C MMU and a latched bounded compiled continuation. Its first
  relocation write reaches a physical-page wait without retirement. Page supply/MSR,
  complete exception/device startup remain open.
  See [the current checkpoint](../vm/check/browser/evidence/2026-10-03-repeat-page-wait.md).
  Scalar memory plus 64-bit PUSH/POP/direct CALL/RET cuts pass 33 modules and
  16,896 native/Node comparisons through the actual C-Wasm access/MMU export,
  with no JavaScript guest-memory callback. CPU exception delivery remains
  unconnected. The CLI
  is built by `all`.
* The C resource gate, resident physical RAM and four-level 4 KiB/2 MiB MMU
  now exist. The MMU checks canonical addresses, level permissions, WP/NX,
  reserved physical bits and A/D updates; a physical cache miss returns an
  exact host request, not a fabricated Linux page fault. Its 49,152 permission
  cases are a model test, not a hardware/QEMU fault-delivery differential.
  Bounded C table dispatch exists; complete closure, CPU exception delivery and
  virtio devices remain unimplemented. The retained `vm/wasm` and `web/vm.js` code still contains
  historical execution machinery. Resource/RAM boundaries alone are not a VM.
* `linux-worker.js` defaults to `linux-x86-64-machine`, which is absent from
  the current catalog and is not the shipped bundle. Re-enabling that old
  catalog entry would not test this release.
* A bzImage includes boot/decompression code and is not just an ELF function.
  Kernel startup, physical/virtual aliases, alternatives/relocation and precise
  instruction faults require an explicit compiled machine/boot boundary.
  `vm/core/boot.c` now borrows only its header and produces initial zero-page,
  command, GDT and identity tables independently by physical page. Kernel and
  initramfs pages return bounded source extents rather than an expanded image.
  The exact shipped kernel/initramfs pass native and C-Wasm initial-state/page
  comparison and MMU fetch at `0x1000200` (`CLD; CLI`). No instruction or Linux
  boot was executed by that gate. Initial-content projection is not a dirty
  RAM cache-miss or suspend resolver. Hidden segment caches, compressed-kernel
  executable admission and root block-device publication still need integration.
* The old fixed CPU table omitted PAE/PGE required by this actual kernel.
  The generated kernel feature-header gate reproduced `missing=00002040`;
  `development-standard-v2` corrects that CPU identity. The distribution
  recipe remains v1 and the published bundle/receipts are unchanged. Matching
  required CPUID bits is necessary, not evidence of complete CPU emulation.
  The frozen root still declares its old contract. A future product publication
  must reconcile that metadata and both execution projections; running a test
  under v2 does not certify the old exact-v1 release contract.
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

The subsequent `provider.html` user observation passes 512 real native-x86
comparisons through the 3,920-byte C-Wasm MMU provider, in ordinary memory at
generation 9. That receipt names its exact build, not later loader additions.
No Linux boot claim follows from either probe. The automated C-provider and
bzImage-startup checks use Node as a Wasm engine, separately from that actual
browser observation. Build with `data/oracle/wasm-tools.ps1`; this pins a
scope-local official SDK and adds no WASI/runtime or distribution dependency.

The compiled table now has one `cut(i32 state, i32 port) -> i64` type, for pure,
memory, stack and the admitted CLI cut. A bounded C dispatcher borrows sorted
coordinate rows, checks executable pages through the C MMU, calls the generated
function table and returns on budget/fault/miss/revocation. No JS cut loop or
runtime decoder is introduced. This is a baseline bounded directory, not the
final minimized dispatch projection or an executable-source attestation.
Same-page prefixes end before crossing instructions, which execute alone.
All guest RAM writes revoke admission conservatively, including MMU A/D
writes: code may alias paging structures. A fetch-time revoke regression was
red before the pre-call fence. Cold source must be observed after MMU admission,
with code, CPU/MMU context, rows and table slots pinned until return.

Raw boot/mutable executable pages use the same C cut plan/lowering/emitter as
accepted ELF segments, with at most two borrowed immutable 4 KiB pages and an
explicit generation. That input does not verify ELF proofs or authenticate a
release. The cold supervisor must establish those provenance/lifetime gates;
the row bounds check alone is not permission to execute arbitrary modules.
Ordinary optimized-ELF admission is retained, not replaced by a synthetic ELF.

The earlier shipped bzImage checkpoint retired `CLD; CLI; XOR eax,eax` through
the C-Wasm dispatcher in Node, without a JS instruction scheduler. It stops at
`0x1000204` (segment load). A 16-case CPL/IOPL CLI model checks IF/#GP and
nonretirement; it is not a native CPL0/hardware exception oracle. The prefix
is only three instructions, NOT kernel/PID 1/browser boot. Whole-image emission
still returns `-104`. The refreshed `provider.html` v2 fixture tests its native
memory records through C table dispatch; its Node driver is not a new manual
browser observation and does not replace the retained v1 receipt.

The latest checkpoint supersedes that three-instruction prefix: typed C memory
RMW, table loads, same-CPL long-mode far RET, control reads/writes and memory
CMP/TEST, register shifts, SETcc, fixed-profile CPUID and stack flags advance to
378 instructions in the actual browser.
The command-line option page also comes from the same authenticated bzImage.
The formerly unlowered `REP MOVSQ` at `0x1000281` now compiles and returns
a C physical-page wait for an 8-byte write at `0x1e283f8`. No element/RIP/
retirement advances on that first miss. Native x86 overlap/parent/fault
receipts, bounded continuation and self-modified-source cases pass.
Next: page-native supply without reopening the VM, MSR and remaining compressed
startup operations, complete executable-generation/load/CPU attestation and
exception entry. A cold compiler and bounded table admission exist; they do
not yet provide whole-image closure or a production authenticated code supply.
Then implement the PC interrupt/timer/RTC/UART boundary and the release
initramfs's actual root-device handoff before adding unrelated device families.
Do not skip that startup with a synthetic ELF, redirect execution into the
old interpreter, or substitute a QEMU boot for this browser gate.

## Compile directly from the shipped native bundle

The authenticated native `.tar.zst` is now a reproducible cold-construction
input. It is not necessary to rebuild the distribution or supply an unshipped
Kbuild `vmlinux`. Run from the repository with C build tools, GNU tar and zstd:

```sh
bash data/oracle/compile-native-bundle.sh \
  artifact/native/os-length3-linux-0.1.0-x86_64-1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195.tar.zst \
  4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc \
  temp/bundle-compiled
```

Obtain the expected digest independently from the authenticated release. The
tool verifies it before extraction, streams only manifest, boot objects and
`root/bin` (including BusyBox's tar hard-link owners), and deletes its temporary
members after construction. It never expands the complete root/RAM or changes
the native bundle. The C loader derives the bzImage entry/source page; the same
C cold compiler handles that page and proof-bearing BusyBox. Source digests,
initial boot records, modules and exact non-closure coordinates remain in the
new diagnostic output. An existing output is refused.

This command deliberately exits **3**, not success: the kernel generates 17
modules / 20 source instructions / 5,024 bytes and stops at the admitted far
RET `0x1000243` (unknown execution continuation); BusyBox generates two modules / five source instructions / 639 bytes and
stops after its admitted direct CALL, before claiming either target/return
closure or execution. A CALL's fallthrough is not a guessed execution trace.
Whole-image `wasm-compiler INPUT.elf OUTPUT.wasm` still refuses with `-104` and
creates no output. `--prefix` and `--code-pages` are explicit bounded
construction modes, not an alternative publisher or runtime fallback.

The cold compiler itself also builds as ordinary Wasm:

```powershell
./data/oracle/wasm-tools.ps1 -Compiler -Output temp/cold/wasm-compiler.wasm
```

Its only import is `machine.memory`; it has no WASI, JS decoder, host filesystem,
allocator or guest instruction interpreter. Privileged construction exports
borrow immutable accepted ELF or up to two executable pages and emit through
the same C plan/lowering. They do not attest source provenance, publish table
slots or certify whole-image closure. Caller source/output/report reservations
are checked; failed reopen revokes prior input. Independently linked compiler
and VM static data/stacks use separate memories; only generated module bytes
cross that construction boundary. Do not instantiate both onto an overlapping
C static-memory layout. Cold memory can be discarded after its derived modules
are placed, but actual RSS reclamation is not measured.

Earlier native C and cold C-Wasm receipts match byte-for-byte in 734 emissions, including
repeats, over the exact bundle/startup prefixes, 83 pure, 22 memory, 11
stack/control, 22 new RMW, 80 control-read, 80 control-write, 16 memory CMP/TEST
and 156 register-shift and 198 register-condition
fixtures. The v3 diagnostic Worker **constructs** its memory cut in C-Wasm,
compares it with the native construction receipt, then executes the generated
cut through the C VM table/MMU for 512 native comparisons. The prebuilt cut is
only an oracle; it is never an execution fallback. The standard browser-control
route now works: actual `provider.html` v3 passes 512 comparisons and
`startup.html` now executes 328,375 shipped startup instructions, retains the independent
full CPU/cache comparison at instruction 86, and checks the absent-option result.
Ordinary memory, secure context and no isolation were observed.
Linux boot and RSS reclamation remain unachieved/unmeasured. Earlier v1 manual
receipts retain their original builds and meaning.

This resolves bundle provenance and a usable construction entry, **not** the
remaining ISA/system/exception/device semantics. Indirect CALL/far control, MSR startup,
complete code/load admission and kernel/device boot remain the next
blockers. Unsupported code must be implemented in the common C lowering and
machine boundary, not skipped or interpreted by JavaScript.

Reproduce the current bounded startup observation with
`data/oracle/prepare-startup-cuts.sh`, then `check-wasm-startup.mjs` and
`prepare-browser-startup.mjs`. The common validator runs in Node and the browser;
it is diagnostic input construction/assertions, not JS guest execution.
The browser no longer downloads native prefix modules or branch-entry lists:
`vm_code` borrows the current C-MMU-checked page and the cold C compiler emits
only the demanded RIP, into one reusable function-table slot. No guest-address
translation, opcode decoding or branch execution is implemented in JS. The
serialized owner pins source and context across engine compilation. This
diagnostic still performs one page transport/C compilation per cut; bounded
engine-instance reuse now requires exact emitted-body equality. C-owned warm
source admission, first-instruction cross-page supply and general async admission are
not established. Its fixture manifest does not authenticate a production release.
See the [page-supply evidence](../vm/check/browser/evidence/2026-10-03-page-supply.md) for
exact hashes, reservation preconditions and the remaining red gates.

REP's C physical misses now use online admission into the same resident index,
not reopening the VM or rebuilding a sorted directory. `vm_page_prepare` names
a virgin slot and exact initial object extent; its ticket, generation, pending
request and CPU/MMU/RIP context fence commit. Existing resident/dirty pages are
never reinitialized. `vm_grow` refreshes only the payload extent and keeps the
compiled continuation/table slot pinned. R resident pages need R rows plus R-1
bit branches; their lookup has a fixed coordinate-bit bound, not an N-sized
logical-RAM directory. This serialized working-set projection is not the wire
Artifact quotient, shared-worker ownership or dirty eviction/recovery.

The actual browser completed and compared the full 3,040,256-byte relocation.
1,481 C page supplies used 47 exact HTTP 206 object ranges and one 64 KiB
diagnostic chunk cache. Streaming length, Content-Range and local chunk SHA-256
are checked before staging; signed release-root/AEAD/ECC admission remains red.
The VM reached 6,815,744 linear-memory bytes, with a separate 1 MiB cold compiler.
That page-supply checkpoint stopped at 193 cuts / 385 retired source instructions.
The [current indirect-JMP evidence](../vm/check/browser/evidence/2026-10-03-indirect-jmp.md)
passes 6,144 actual x86/C-Wasm CPU comparisons, including 768 #GP receipts,
and the unemitted-successor/pure-prefix regression. In the actual browser,
195 cuts / 391 retired instructions include the independently checked transfer
`0x10002a1 -> 0x1e20d00`; that historical checkpoint's red was REP STOSQ
at `0x1e20d17` (`-102`).
No step at the erroneous zero-page RIP is counted as progress. This still is
not Linux boot or a 3-second shell, and production storage/network acceptance
remains open. Native bundle and human UI are unchanged.

The [earlier common-lowering evidence](../vm/check/browser/evidence/2026-10-03-stos-alu-cmov.md)
closes REP STOS, register-destination memory ADD/SUB/AND/OR/XOR and register
CMOVcc through the common C compiler. Native x86 CPU/RAM/fault observations,
13,312 memory-ALU and 26,112 CMOV comparisons, and 431 exact native/cold emission
comparisons pass. The actual browser compares the full relocation, 98,656 BSS
bytes and three scalar zero-fill returns totaling 131,104 bytes. It reaches
328,375 retired instructions / 262,536 demanded admissions, mostly scalar
memset iterations, not a coverage percentage or an `/init` estimate. The next
red is indirect `CALL [r12]`, `41 ff 14 24`, at `0x1e25239` (`-102`).

Engine work reuses identical C-emitted modules, bounded to 64 instances /
256 KiB within one Worker owner, without decoding source or choosing guest
branches. There were 221 engine compilations / 262,315 exact-body hits; 19,657
emitted bytes remained in the cache. The C compiler still runs on every cut,
and code-page transport accumulated 1,075,351,552 bytes. This repeated work is
not eliminated or misreported as resident/delivery size. The active table has
one slot; VM/cold memories stay 6,815,744 / 1,048,576 bytes. Linux boot and the
3-second cold shell remain red. Next test indirect CALL fault ordering and
remove C reanalysis/page-copy fixed costs with C-owned source admission before
claiming production executable-generation/load or storage/device closure.

### Indirect CALL and register-bit checkpoint

The [current evidence](../vm/check/browser/evidence/2026-10-03-call-bit.md)
adds common near indirect CALL and register BT/BTS/BTR/BTC. Actual x86
observations established a critical ordering: load the target with old RSP,
store the return address, then check target canonicality. A target #GP keeps
the stack payload store but not the CPU/RSP/RIP update. All 27 CALL forms /
6,912 CPU/stack comparisons match C vm.wasm, including 2,150 fault frames;
448 retain that #GP store. Register bit operations pass 60 post-linked ELF
modules / 30,720 defined-flags and complete-state cases in direct Wasm and
separately through the C dispatcher. Undefined bit-operation flags retain
the chosen representative; they are not mislabeled as hardware-defined.

Actual browser startup now reaches 330,245 retired instructions / 263,420
demanded admissions. The next exact unsupported instruction is `19 c0`,
`SBB eax,eax`, at `0x1e24306`. One table slot, the independent relocation/BSS/
memset observations, 47 exact HTTP ranges and 6,815,744-byte VM memory remain.
The cache retains 64 instances / 20,024 bytes; its 659 engine compilations
and 262,761 hits do not remove per-cut C reconstruction or the cumulative
1,078,972,416 code-copy bytes. No interpreter or address-specific shim was
added. Linux boot, exception entry, authenticated production root/device
integration, offline development, storage/network use and cold-shell 3s
remain red. The same full product goal is unchanged.

### Carry and memory-conditional-move checkpoint

The [latest evidence](../vm/check/browser/evidence/2026-10-03-carry-memory-cmov.md)
closes register ADC/SBB and memory-source CMOVcc through common C lowering.
Incoming CF joins the reverse frontier even when all outgoing flags are killed.
66 carry modules / 33,792 native comparisons pass in direct Wasm and C dispatch;
54 memory-CMOV modules / 27,648 CPU/RAM comparisons and 27,136 actual protection
faults pass through the C MMU. The source load faults even when the condition
is false; no parent/RIP/retirement is published on that fault. False 32-bit
destinations zero their high parent only on successful access.

The actual browser reaches 368,735 source instructions / 284,606 admissions,
past both previous compiler refusals. It now stops on pending #PF(2), address
`0x1000000`, at `0x1e21913` (`45 88 32`, decompressor output store), CR3
`0x1e41000`. Linux's upstream stage-2 IDT and `do_boot_page_fault` supply the
identity-map handler. The C VM currently returns pending fault metadata but
does not enter that guest handler. Next implement exact IDT/stack/CR2/IRET
semantics with a system/hardware oracle, not a host mapping shim. The old
physical-wait request fields are distinct from the current fault fields.

All relocation/BSS/memset observations remain green. VM/cold memory and 47
HTTP ranges are unchanged; one table slot is active. Bounded engine reuse
retains 64 instances / 20,360 bytes, but C compilation still occurs on every
cut and code transport accumulates 1,165,746,176 bytes. That is work, not
resident memory or artifact size. Native bundle and human UI are unchanged;
Linux/PID 1/shell, production storage/network and cold-shell 3 seconds remain
unachieved. The full product goal is still active.

### Common fault-entry and IRETQ checkpoint

The [current evidence](../vm/check/browser/evidence/2026-10-03-exception-entry.md)
closes the previous decompressor #PF through the guest IDT, not host mapping
repair. C validates the CPL0 long-mode IST=0 gate/code/frame and enters Linux's
own handler; cold compiled IRETQ restores its five-word return frame. One
160-byte C event frontier preserves consumed descriptors and completed stores
across physical-residency waits, including an IDT/stack alias. No full CPU
snapshot or JavaScript handler address is used. RF survives fault/return and
clears on the next ordinary successful retirement.

96 QEMU TCG system-oracle #PF/#UD/#GP frames match native C and C-Wasm; all
96 compiled IRETQ returns and following RF clears pass. Full product checks,
all linked C VM core ASan/UBSan and fresh control/carry/memory-CMOV regressions
pass. TSS/IST, outer privilege, #DF/triple fault, IRQ/NMI/debug, complete IRET
fault ordering and production storage admission are still open, not inferred
from these frames.

Actual browser startup reaches 1,616,430 retired source instructions /
1,000,000 admissions; the guest handler returns and decompression progresses.
The next stop is the explicit diagnostic quota, not Linux boot. All earlier
independent CPU/copy/BSS/memset observations remain green. Code-page recopy
accumulates 4,096,000,000 bytes, C construction about 7,905 ms versus execution
555 ms. These are repeated work, not memory residence or artifact size. Next
remove this fixed cost with C-owned reusable source admission and exact source,
lifetime and alias validation before widening startup further. Native bundle
and human UI remain unchanged; the complete product goal is active.

### C-owned source-admission checkpoint

The [source-admission evidence](../vm/check/browser/evidence/2026-10-03-source-admission.md)
eliminates the previous repeated C construction/transport before engine reuse.
C keeps 64 exact source-extent rows and 6,216 bytes of candidate/write indexes,
not copied source pages. Every query still performs executable MMU admission;
physical RAM/A/D/reservation writes invalidate intersecting rows before mutation.
Unknown compile spans are page-pinned during async engine installation; writes
cancel publication. Host remap/table changes require reset. Compiler/profile,
residency and CPU state remain pinned by one serialized owner, not an SMP proof.

At exactly the same 1,616,430 retired instructions and complete observed CPU
quota state, 1,000,000 C compile calls fall to 1,967, and cumulative code recopy
falls 4,096,000,000 -> 8,056,832 bytes (99.8033%). Fetch, resident pages/memory,
source release and independent relocation/BSS/memset observations are unchanged.
This is work reduction, not artifact compression or a boot-time benchmark.
The pending-source observer and private function-table overlap were red first
and are covered by native/C-Wasm regressions. Source payload copies are zero
inside the metadata cache; miss transfer to the independent compiler remains.
Next widen actual startup/decompression, preserving explicit budgets and the
full product goal. Crossing-first-instruction admission and production storage
remain open; a reusable one-page cut is not whole-machine closure.

### Extended actual decompression checkpoint

The [extended receipt and inventory](../vm/check/browser/evidence/2026-10-03-decompression.md)
reach 100,000,000 retirements / 49,451,059 admissions, with four guest #PF
handlers returning via IRETQ. Output R10 reaches `0x17be190`; the next stop is
the explicit diagnostic quota, not Linux boot or a complete CRC/output proof.
The default small diagnostic remains unchanged; `?budget=extended` deliberately
selects the larger budget, 8,192 slots and at most 32 MiB memory. Actual VM
memory is 12,058,624 bytes / 2,788 pages; fetch remains 47 exact ranges.
Capacity refusal reports a resident quota separately from guest #PF or compile
refusal. Native release and human UI remain unchanged.

The largest recorded bucket is now engine replacement, then VM execution and
source/MMU admission. Analyze exact instance/topology reuse and C-owned
multi-cut dispatch while preserving precise fault/A/D/source alias semantics,
not an unbounded cache or a decoder in JavaScript. Finish decompression and
validate its full output before calling Linux entry green. The complete
development/storage/network goal and cold-shell three seconds remain open.

### Full decompression and actual ELF entry checkpoint

The [Linux-entry evidence](../vm/check/browser/evidence/2026-10-03-linux-entry.md)
records 129,057,478 source retirements / 64,417,773 admissions in the real
ordinary-memory browser Worker. All 14,622,864 decompressed bytes / 3,571
pages match independent gzip output before Linux's own PT_LOAD memmoves.
Only bounded C-MMU views and diagnostic page digests are observed; no host
decompressor supplies guest output or skips startup. PREBOOT uses raw inflate,
so the CRC/ISIZE verification belongs to the independent oracle, not a claim
that Linux itself checked the gzip trailer. The actual guest then executes
the shipped ELF entry 0x14015e4 and stops on unsupported WRMSR at 0x14015f7.
Linux/PID 1/shell and cold shell three seconds remain unmet.

Common two/three-operand register IMUL at 16/32/64 bits closes the preceding
real ELF-parsing refusal. Defined CF/OF, sign-extended immediates, source/target
aliases, narrow parents and interior flag consumers match 16,384 actual x86
cases in direct Wasm and separately the C dispatcher. Undefined flags are
chosen, not incorrectly compared with hardware's incidental values. No kernel
coordinate callback or JavaScript guest semantics were introduced.

Default diagnostics remain at 1,000,000 admissions / 2,000,000 retirements.
`?budget=extended` now permits 150,000,000 / 300,000,000 and 32 MiB maximum
memory; progress is observational and does not dispose/restart the Worker.
The current high-water is 15,728,640 bytes / 3,687 resident pages. The 47
object ranges do not include diagnostic fixture/module/page-hash-list requests
and are not a production total-transfer or signed-root/AEAD/ECC proof.
Native archive and human UI bytes are unchanged. Close the common MSR boundary
next, then demanded kernel/device semantics, PID 1 and full product acceptance.

### CPU controls, division and high-virtual memory-bit checkpoint

The [current common-path evidence](../vm/check/browser/evidence/2026-10-03-misc-arithmetic.md)
closes Intel MISC_ENABLE/effective CPUID, all six implicit sign extensions,
8/16/32-bit register DIV/IDIV with precise #DE, and immediate memory
BT/BTS/BTR/BTC through existing C-MMU reservation/commit. Native observations
and direct Wasm/C-dispatch checks distinguish defined flags from chosen
undefined representatives. Memory-bit checks cover direct C-MMU invocation,
not a second table-dispatch/exception-entry claim. 316 native/cold emissions,
full product checks and selected lowering ASan/UBSan pass. 64-bit/memory
division, LOCK/register-indexed memory bit strings and pending time/syscall
MSRs remain explicit admission boundaries. There is no source interpreter,
guest patch or changed CPU signature. QEMU's MISC oracle validates legal
transport only, not its missing CPUID side effects.

Actual browser executes 129,063,662 instructions / 64,421,578 admissions,
adopts Linux's own high virtual mappings and delivers six real #PFs to guest
handlers. Decompressed output still matches all 14,622,864 bytes before
PT_LOAD moves. Next refusal is memory INC (`ff 05 a1 c8 75 00`) at
`0xffffffff81401759`, effective address `0xffffffff81b5e000`. Close the common
memory unary family and its fault/CF/commit rules, not a coordinate-specific
shim. PID 1/shell, full closure, authenticated storage/network and cold shell
three seconds remain red. Native publication and human UI are unchanged.

VM/cold memory stays 15,728,640 / 1,048,576 bytes and source payload-cache
copies stay zero. Engine replacement 33.9 s, execution 30.2 s and admission
19.7 s dominate cold construction 6.0 s in this single diagnostic run; they
are not cold-ready measurements. 1,511,206,912 cumulative code-copy bytes
are work, not artifact/resident/delivery size. 47 object ranges still exclude
the diagnostic fixture/module/output-digest requests. Bounded cache capacity,
source alias invalidation and explicit waits remain mandatory when reducing
these costs. The full product goal is active, not completed by diagnostic pass.

### Memory unary and demanded instruction-tail checkpoint

[Current common-path evidence](../vm/check/browser/evidence/2026-10-03-memory-unary-source-tail.md)
closes 8/16/32/64-bit memory INC/DEC/NEG/NOT through C-MMU reserve/commit.
INC/DEC retain CF; failed transactions publish neither flags nor CPU/RIP.
22 post-linked forms / 11,264 CPU/RAM / 10,240 actual protection-fault /
21,504 RF checks pass. Fresh CMOV memory, full product checks, selected compiler
sanitizers and all VM-core ASan/UBSan are green; sanitizer scopes and stale
fixture rejection are explicit in the evidence.

The following boundary failure was a truncated FIRST instruction, not an ISA
fallback. The common compiler returns `WASM_COMPILER_ERROR_FETCH` (`-105`)
without publication. `vm_source_query` reserves **two** 24-byte code views,
initially zeroing the unused tail. Only that compiler demand invokes
`vm_source_extend`; C MMU owns its next-page permission/residency/translation.
A cached crossing also revalidates both pages. Publication allows only one
crossing instruction of at most 15 bytes. Known source extents watch both
physical offsets; pending compilation pins both whole pages. A-bit alias
writes cancel the pin and return stale admission, requiring re-query at the
same unretired RIP. No JS opcode or virtual-to-physical interpretation occurs.
Native bounded/source alias cases and ten actual C-Wasm cold emissions cover
non-contiguous owners, writes/cancellation, NX/nonpresent/residency, remap,
generation, grow/rebind and C dispatcher rejection. 338 native/cold emissions
remain byte-identical. This serialized-owner contract is not an SMP lease proof.

Actual browser: 129,071,601 instructions / 64,425,459 admissions; all 14,622,864
decompressed bytes still match. Six #PFs and one #GP are handled by the guest.
The next refusal at that checkpoint was ordinary non-LOCK memory CMPXCHG at `0xffffffff81096d52`.
PID 1/shell, full closure and storage/network acceptance remain red. Source
metadata is 6,752 bytes / 64 rows, with zero payload copies. VM/cold memories
remain 15,728,640 / 1,048,576 bytes. Engine replacement 35.6 s, execution 30.8 s
and admission 20.1 s dominate construction 6.0 s in this single diagnostic;
none is a cold-shell or controlled speed comparison. Native archive and human
UI are unchanged. The full goal is active.

### Scalar memory compare/exchange checkpoint

[Current evidence](../vm/check/browser/evidence/2026-10-03-memory-exchange.md)
closes scalar CMPXCHG with/without LOCK at all widths. The native typed effect
and proof are unchanged; this projection specializes it to SSA plus existing
C-MMU reserve/commit, not a runtime opcode callback. Both arms perform a write
cycle, including equal-byte mismatch. LOCK assumes synchronous serialized
ownership of ordinary memory, not SMP; both provider and emitted modules reject
shared-memory linking. 32 post-linked forms pass 16,384 CPU/RAM, 14,848 native
fault and 31,232 RF checks. Four source-alias cases separately pass C dispatch.
Full product checks, selected lowering ASan/UBSan and 370 native/cold emissions
are green. Actual browser reaches 129,078,646 retirements / 64,428,968 admissions
with unchanged decompression witnesses. Next refusal: memory SETE at
`0xffffffff81096421`. Linux/PID 1/shell and the full product goal remain red.
Human UI/native publication are unchanged; component pass is not boot.

### Memory condition-store checkpoint

[Current evidence](../vm/check/browser/evidence/2026-10-03-memory-condition.md)
closes all 16 memory SETcc predicates through the existing condition SSA and
C-MMU byte store. False also writes; flags and GPRs remain unchanged. 25
post-linked forms pass 12,800 CPU/RAM, 12,288 native fault and 25,088 RF checks.
32 entrance assertions were red first; exact RSP encoding, prefix separation,
ignored ModRM.reg and fixed-byte width are covered. Two source-alias cases
separately retire once through C dispatch and revoke equal-byte false stores.
Full product checks, selected lowering sanitizers and 395 native/cold emissions
pass. Actual browser reaches 129,387,892 retirements / 64,571,332 admissions;
all decompression witnesses stay unchanged. Next refusal is register-index
memory BTS at `0xffffffff81054a7c`, whose signed word-offset calculation remains
open. PID 1/shell and the full goal remain red; component pass is not boot.
Human UI and the native publication are unchanged.

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
* [Linux legacy 64-bit boot protocol](https://www.kernel.org/doc/html/latest/arch/x86/boot.html)
* [Intel architectural/instruction manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
