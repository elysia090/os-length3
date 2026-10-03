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

Native C and cold C-Wasm outputs match byte-for-byte in 734 emissions, including
repeats, over the exact bundle/startup prefixes, 83 pure, 22 memory, 11
stack/control, 22 new RMW, 80 control-read, 80 control-write, 16 memory CMP/TEST
and 156 register-shift and 198 register-condition
fixtures. The v3 diagnostic Worker **constructs** its memory cut in C-Wasm,
compares it with the native construction receipt, then executes the generated
cut through the C VM table/MMU for 512 native comparisons. The prebuilt cut is
only an oracle; it is never an execution fallback. The standard browser-control
route now works: actual `provider.html` v3 passes 512 comparisons and
`startup.html` executes 391 shipped startup instructions, retains the independent
full CPU/cache comparison at instruction 86, and checks the absent-option result.
Ordinary memory, secure context and no isolation were observed.
Linux boot and RSS reclamation remain unachieved/unmeasured. Earlier v1 manual
receipts retain their original builds and meaning.

This resolves bundle provenance and a usable construction entry, **not** the
remaining ISA/system/exception/device semantics. Indirect CALL/far control, REP store/MSR startup,
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
diagnostic still performs one page transport/compilation per cut; warm compiled
code reuse, first-instruction cross-page supply and general async admission are
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
`0x10002a1 -> 0x1e20d00`; the next red is REP STOSQ at `0x1e20d17` (`-102`).
No step at the erroneous zero-page RIP is counted as progress. This still is
not Linux boot or a 3-second shell, and production storage/network acceptance
remains open. Native bundle and human UI are unchanged.

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
