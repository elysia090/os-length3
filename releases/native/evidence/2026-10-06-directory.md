# C Artifact path connected to the modern VM — 2026-10-06

## Actual missing boundary

The modern VM previously linked no Artifact/Storage reader. A source miss
unconditionally ran the C compiler, then compared its newly emitted bytes
against the engine cache. Exact engine reuse therefore still paid repeated
construction. The full source profile classified almost every cold reservation
as full-owner replacement, not a retained-row write or sampled budget/remap.
This reader is a necessary connection toward precompiled physical delivery;
it does NOT by itself eliminate those Linux startup recompilations.

## One reader, not another format/authority

The existing Artifact index already supplies authenticated <=4 KiB nodes,
bounded rank lookup and canonical SHA-256 identities. Its same C sources now
link into the modern VM. No private index/tree/hash code, opcode table, ISA
decoder, guest interpreter or JS canonical-row parser was added.

Artifact's existing resource type has one 80-byte little-endian index row:
key, immutable object identity/extent/type/version, coordinate and generation.
This is a delivery descriptor, not a saved executable instruction or a new
CLI program format. Native postlink output remains ordinary ELF. Native and
Wasm readers/writers have one `artifact/sources.mk` population; archives are
rebuilt from that exact population so removed members cannot survive.

The VM owner retains exactly 304 bytes: root, current expected reference,
one selected resource, key, generation/ticket frontier and role/cap. It owns
neither a directory array nor payload storage. One reply buffer can be reused
after C copied only the next reference or selected descriptor. Each node is
hashed and structurally checked before rank selection. A leaf must match the
requested role and generation and remain inside the admitted object cap.
Only an exact full object-byte match reaches READY.

Web receives a 56-byte transport request: generation, non-reused ticket,
opaque digest, bytes and resource kind. It can choose a transport/cache tier,
but cannot parse canonical nodes, choose a different child or authenticate a
reply in place of C. The verified buffer must stay pinned until these exact
bytes are consumed by the engine; refetch after verification is forbidden.
Wrong generation/ticket, corruption, truncation and duplicate object reply do
not publish a second object. Cancel and close preserve the sequence frontier;
same-instance reopen cannot reuse an old reply. Counter exhaustion refuses.
A fresh/destroyed Worker additionally needs a fresh non-reused outer authority
scope; that broker/recovery integration is NOT proven here.

Crucially, the supervisor must first select/authenticate the correct release
or program root. A caller-chosen digest is not authorization. Artifact byte
identity does not prove x86 equivalence, Wasm type, source/MMU permissions,
executable-generation closure, storage confidentiality or durability. Existing
compiler/source/table obligations remain mandatory; no loader fallback exists.

## Red and green evidence

The frozen previous VM is red: it has no `vm_directory_bind` or related C
exports. The new native check uses the EXISTING C writer to build a 3000-row,
three-level index, then checks all 3000 lookups, role/cap refusal, malformed
resource metadata, stale/corrupt/truncated replies, cancellation, same-scope
reopen and ticket exhaustion. Every path touches exactly three bounded nodes.
This is a finite index/lifecycle model, not the Linux program population.

Provider receipt: six lookups in
that fixture use 18 node reads + six object reads, 49,350 bytes total and 73
fault/control assertions. C verifies a real C-emitted 241-byte ordinary Wasm
module; the pinned exact bytes enter the ordinary engine, then C source/MMU/
table dispatch retires its three source instructions with full CPU equality.
The test does NOT build the index or decode its rows in JavaScript. Its opaque
file transport is a fixture, not a managed storage/VFS implementation.

Full native Artifact and VM checks pass. `directory-sanitizer-check` compiles
the precise directory/index/resource/object/SHA reader and its native model
with ASan/UBSan; all 3000 paths/control cases pass. New compiler warnings were
fixed, not suppressed. This is not a Wasm-engine sanitizer claim.
The source cohort and
interrupt/HLT model + independent x86 receipt
remain green. The short same-bundle prefix
preserves the independent 86-instruction CPU checkpoint and reaches 1,617,931
retirements, then the unchanged diagnostic bound. It does not use the new
directory for Linux module delivery and is not Linux/browser acceptance.

```text
vm.wasm 79,421 bytes
d51851ad4b359a35851aca74a1b53d5810f036ca71ab56bf8e4f2032e4a8ca8e
fixture emitted-cut.wasm 241 bytes
07ad81056d5588f4c1ece037274327cb1fa954b7bbb2ab739d81be41d9df05b3
fixture encoded root reference
6108aebda15cbc2c1bdf43d16eb966b01577d1738b6d1d6c6de03cd570b89c27
```

The VM increases by 8,342 bytes relative to the HLT-only build because the
missing C authentication reader is now present. No Linux delivery-size or
speed reduction is claimed. Native publication SHA-256 remains
4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc.
Human UI, retained browser Workers/staged assets, source/engine quotas and
guest service/time policies are unchanged.

## Next real connection

Produce a complete bounded module/page projection from accepted optimized ELF,
with compiler-carried span/binding/CPU/fault/control obligations, and select its
authenticated root through the release contract. Feed that into this C path
and the existing engine/table owner instead of reconstructing an already
compiled transfer at every 64-row source eviction. Observed RIPs or a prefix
cache are not whole-image closure. `wasm_emit_function`/dispatch remain
incomplete; normalized scalar-SSA backend migration is still required.

The just-completed HLT-only Linux run correctly halts but s6 synchronization
still fails. Resolve service/IPC/scheduling and real idle-event delivery
without slowing clocks, relaxing timeouts or skipping waits. Complete encrypted
and erasure delivery, dirty workspace/root recovery, granted network/browser
services, old web/catalog retirement and actual-browser offline development
acceptance. The full goal, including cold shell three seconds, remains active.
