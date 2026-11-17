# Runtime foundation: authority, ownership and compatibility

Design checkpoint, 2026-11-17. This is a target and a set of admission gates, not a claim that the migration or display compatibility is complete. Draft PR #217 is still in development.

## Goal

Make ricebox, sods and muk independently usable foundations, with one owner for each semantic decision and explicit host capabilities. Move Linux authority and its work into Rust by complete caller slices; keep TypeScript as thin engine/host/product adapters where it is actually needed. Establish everyday's display/input compatibility with existing clients, including existing terminal applications. An arm target is a later validation example, not the objective.

Do not use language choice, a folder move, a passing unit import rule or a small benchmark as proof of ownership, compatibility or a performance lower bound. Preserve strict correctness and the existing cold first-Prompt budget.

## Responsibility seams

| Owner | Owns | Must not become |
| --- | --- | --- |
| ricebox | Packages, canonical roots, stored distribution/integrity, release selection/cache policy, prepared root lifetime, bundle composition | Another Linux kernel or OCI parser |
| sods translator | Accepted executable/instruction semantics, generated Wasm/facts, translation identity and incremental code | A distribution or display-policy owner |
| sods Linux | Guest paths/mounts/inodes, credentials, FD/OFD state, processes, images, syscall effects, signals, mappings and PTYs | Host-service policy asserted by a TS caller |
| muk | OCI configuration/policy, isolation and making/supervising a box through Linux calls | A layer reader, terminal renderer or second retained runtime service |
| prompt | Attaching a supplied PTY master, I/O/resize and outer-terminal restoration | A process launcher or graphical terminal implementation |
| everyday | Compatibility/integration with selected existing display/input clients and sessions | A replacement terminal, unselected compositor, or language rewrite as an end in itself |

Current module/public-import checks in `scripts/units.ts` and `scripts/runtime-boundaries.ts` protect useful dependency directions. They do not prove semantic uniqueness, provenance, physical stop or safe retirement.

## Current execution profiles are different proof domains

- **Native ricebox:** verified root directory, `ricebox/src/bundle.rs`, native `muk run`, host Linux. Terminal attachment receives a PTY descriptor and uses prompt. The caller owns launch/disconnect policy; prompt owns attachment and terminal restoration.
- **Production browser/ricebox:** checked distribution, compiled translator/AOT modules, prepared lazy Vfs, translated muk, then guest programs through `Kernel`/`RemoteKernel`. Broad Linux authority is still TypeScript. Shared-memory pages use CPU Workers with one Linux owner; the alternative runs guest threads in turn.
- **Ordinary Node:** the same legacy Linux graph with Node host adapters. Do not describe it as the Rust-managed profile.
- **Opt-in `run.ts --managed`:** a real Rust-owned path/credential/Program/stack/image/OFD/stdio caller, one Node Worker and observed stop/holder retirement. Its syscall profile currently admits read, host-stream write and exit. It is static, fixed-memory, rootless, non-TTY and does not run a whole ordinary shell or muk environment.
- **Everyday:** the current implementation is a theme-value parser. The borrowed native Wayland-session profile in `module/everyday/DISPLAY-INPUT.md` remains a compatibility gate, not a completed compositor/session.

See `module/{ricebox,sods,muk,prompt,everyday}/README.md`, `module/sods/linux/README.md`, `module/sods/runtime/host/node/run.ts` and `module/ricebox/runtime/worker.ts`.

## API and ownership target

An opaque identity must carry an incarnation and an owner. A reusable fd number, path string or TS object identity alone cannot authorize a delayed operation.

Keep these distinctions visible:

- storage versus a mounted view and mount topology;
- FD slot versus shared open-file description and offset;
- process/task execution versus image generation and physical memory binding;
- canonical source identity versus one source-load attempt;
- admitted operation versus issued host work, confirmed effect, host-access completion and retirement.

Each admitted operation retains the exact OFD/source/image/backing owners it needs. Input validation precedes irreversible work. Host work starts once, after admission. Confirmed-prefix evidence is cumulative and distinct from evidence that the host has stopped accessing memory. Offset/state commitment uses the matching operation identity, not an inferred callback order. Unknown completion is retained ownership, not permission to retry an effect.

Cancellation closes admission or records intent; it is not proof that an issued request, copy or Worker stopped. Wasm unwind, Node Worker exit, browser termination acknowledgement, source completion and output acknowledgement are separate events. A timeout cannot manufacture one from another. Preserve the original failure and independent cleanup uncertainty. Explicitly retire completed observations rather than retain unlimited terminal history.

The Rust target owns path resolution and permission decisions, not a TS-resolved inode supplied as an assertion. Expand by complete callers and then remove the equivalent TS authority. Moving individual syscall methods while retaining TS path/readiness/offset decisions is not that cutover.

Host adapters still own actual WebAssembly/Worker objects, bounded fresh views/copies, transport, clocks/entropy, cache and host files, physical completion observations and DOM/product presentation. C muk remains the one OCI policy/configuration owner.

## Immediate design candidate: trusted AOT without eager source ELF

### Existing capability

`module/sods/src/image.rs` puts loadable ELF bytes in standard Wasm data segments, followed by `sods.facts` and `sods.starts`. `runtime/translation/share.ts` can hold segments outside the module for controlled guest initialization.

`Image`, `Kernel.prebuilt` and `Process.execve` in `runtime/linux/process.ts` already support preparing and running a translated inode without reading its payload. The source is retained through `readLater` for later demand. `test/runtime/kept.test.ts` includes a whole-AOT lazy-root case asserting zero source reads.

This does **not** reconstruct the complete ELF. Non-loadable sections and original file layout may be absent. `/proc/self/exe`, ordinary reads/copies/hashes and fallback/incremental translation still require the canonical file bytes.

### Avoidable work above that capability

`module/ricebox/runtime/root.ts::hot` eagerly downloads both the original ELF and its translation. `Webroot.files`, Worker `Program extends Given` and `prepareTree` then require/provide those bytes before attaching the image.

For root 0.6.5 pinned in [`why/prompt/roots/pins.rs`](../why/prompt/roots/pins.rs), the original ELF blobs total **1,291,445 gzip bytes** (Node 24.22.1, gzip level 9, no HTTP headers). The archive is 115,302,848 bytes, SHA-256 `ec84d6a4f34359f322726e323e294b03987a19b1aa544563c846ca1a83060ee3`; `node scripts/root-file.ts DIR` fetches and verifies that pin.

| Source | Expanded ELF SHA-256 | gzip bytes |
| --- | --- | ---: |
| bash | `b1579dd0f80f0a7afa772bfe389d73ce1b5c1e4c7e548dd839782f3bac82d95f` | 892,419 |
| BusyBox | `5b10f1705ad5250b74aa56548d72263db52c9737061db005c8186c8c295e4d63` | 399,026 |

These are direct compressions of the verified source files, not assignments inferred from unlabeled network blobs. Removing eager demand could avoid that input only if rehearsal and first-Prompt execution do not actually read it. This is a hypothesis to test with real demand/transfer tracing, not a promised net saving. Later pack/table reads can replace some of that work.

### Association contract before implementation

Use a distinct prepared-executable association. Do not use dummy bytes, an empty replacement inode, or silently make ordinary `Given.bytes` optional.

The association needs:

1. verified release and index generation;
2. canonical source/inode identity, including hardlinks, with source digest, size and revision;
3. translator identity and output-affecting options;
4. verified image artifact and matching facts/segments;
5. shared/unshared preparation mode.

The current manifest has a translation path/source digest and ELF/Wasm blob descriptors, while canonical file entries identify pack location/length/size. The producer captures both from the same source bytes, but this producer consistency is not an explicit raw-digest field on each canonical file entry. Preserve and document the existing trust boundary or strengthen the generated association; path plus equal size is not content identity. Verifying an AOT blob never proves it was a correct translation of an arbitrary source by recompilation.

Required behavior:

- Attach only to the matching unchanged canonical inode. Reject or decline stale/missing/wrong-root associations, never bind to a replacement or restore an overlay merely to make the AOT match.
- Preserve ordinary executable mode, credentials, mount `noexec`/`nosuid`, path and symlink checks in the Linux owner. Compilation success is not execution authorization.
- Keep canonical payloads lazy and authenticated. A demanded source read must use the root's normal integrity path and exact bytes, not loadable-segment reconstruction or another revision labeled with an old origin.
- A failed compile leaves the canonical inode available for ordinary execution/translation fallback. An unused unavailable source need not be fetched just to establish that it is unused; on-demand source failures remain real failures.
- Preserve revision checks, mapping settlement and changed-source/cache-detachment rules. Do not broaden the existing running-image mutation contract as a side effect.
- Preserve existing public byte-bearing file values. Prefer an additive/internal association channel or an explicit versioned prepared-root profile over silently changing `filesNow`, Worker messages or `Given` semantics.
- Retain the canonical source owner for `/proc/self/exe`, deliberate reads and unexpected misses. Rust-managed startup has no authenticated prebuilt route yet; that is a separate later contract.

Acceptance gates:

- a lazy source loader that throws if touched during successful trusted-AOT start;
- actual bash/BusyBox rehearsal and first-Prompt demand tracing;
- deliberate `/proc/self/exe`/ordinary reads, compile failure and incremental miss;
- changed inode, same-size replacement, wrong origin/root, hardlink and symlink behavior;
- permissions/noexec, malformed/mismatched artifacts, source integrity/unavailability;
- repeated starts, late hot arrival, cancellation/retirement and selected Rust payload ownership;
- unchanged strict cold-budget browser test with all real network bytes counted.

## Conditional work and cost ledger

- **Integrity:** authenticating fresh bytes requires inspecting the bytes covered by that digest, unless a valid trusted result is reused. It does not require every unrelated lazy file at startup.
- **Translator ownership:** the current independent-buffer JS/Wasm API copies B source bytes into linear memory and W output bytes out via `slice`, besides writing a fresh W-byte output. These are current interface/ownership costs, not a universal property of Rust or translation. Logical bytes are not physical DRAM traffic or CPU-instruction counts.
- **File delivery:** distinct canonical and guest storage requires populating the accepted destination. The standalone file-store scratch route currently adds another copy; the integrated Rust Linux route can avoid that scratch stage. Two copies are not a universal floor.
- **Mappings:** without trusted dirty metadata, establishing that arbitrary writable backing has not changed can require inspection. Whole-page overwrites are unsafe under independent aliases and partial failure. The current ledger's `1 + 5r` crossings for r dirty runs is an implementation boundary cost, not an inevitable Linux cost.
- **Fork:** independent observable state needs distinct ownership, but eager full-memory copies and retained-capacity scans are not universal requirements. `CLONE_VM` shares memory and has different ownership.
- **Scheduling:** the managed Node profile's synchronization round trip through one 88-byte syscall slot follows its central-owner placement. It is not a universal Rust/Linux floor.
- **Display:** live clients/toolkits/fonts/events and unreleased backing retain real state. A chosen `k * buffer_size` ledger does not prove that k buffers are necessary. Native shared backing need not imply a JS copy; a bridge must account for its own queues, copies and acknowledgements.

Compare identical inputs and accepted behavior, generated Wasm, bounded native disassembly and measured runs. Keep compilation, startup, steady execution, copy volume, retained memory and wire bytes separate. A constant-result benchmark can have an O(1) specification even when the existing native binary runs a loop.

## Existing terminal/display compatibility sequence

1. Finish translator correctness and full current-source/CI gates without relaxing thresholds.
2. Specify/test the lazy-source association independently of whole-kernel migration.
3. Record the compatibility/ownership matrix for ordinary Node, browser/ricebox, native muk and everyday.
4. Expand Rust by complete slices: canonical root/source identity; authorized mounted open with same-OFD read/close; startup/environment/devices; stream readiness/signals/TTY; process/exec/fork; mappings and remaining muk requirements. Remove duplicate TS authority at each proven cutover.
5. Validate actual existing non-TTY utilities before an actual shell; validate PTY, resize, input, signals and job control before claiming terminal-client readiness.
6. On an explicitly lent existing native Wayland session, select/pin ordinary foot and basic Waybar and record advertised protocols, output/input/repeat, resize, job signals, output loss and cancellation. No suitable live session has been established by this design record.
7. Select and prove a guest display route separately. Current guest AF_UNIX/SCM_RIGHTS/memfd/mapping tests do not provide a native Unix/FD bridge: `Outside` only provides IP/port TCP/UDP. Copying `WAYLAND_DISPLAY` cannot bridge translated foot to a host compositor.
8. Add launcher, notifications/actions, wallpaper and Quickshell only behind their own task/dependency gates. Validate the later arm example after the general contracts, not by defining the architecture around it.

Foot terminfo is not a foot executable; the current root has no demonstrated coherent selected foot/Waybar/compositor release. Do not fill this gap with a TS Wayland implementation or a new Rust terminal.

## Decisions still requiring evidence

- Explicit prebuilt provenance and on-demand availability contract, and how it coexists with public byte-bearing file APIs.
- Compatibility horizon for raw public Vfs/Kernel object graphs during the Rust cutover.
- Live-host-root snapshot/reload behavior.
- Selected guest display/FD/backing bridge and actual client release closure.

Folder names, language quotas and a new everyday daemon do not settle these decisions.
