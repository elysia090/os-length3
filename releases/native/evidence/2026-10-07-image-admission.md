# Authenticated image execution admission — 2026-10-07

The whole-image directory at `106661a` could authenticate an IMAGE_MODULE,
but could not admit its source span or dispatch its ordinary `entry` in C.
That frozen VM is independently red: its image-admission exports are absent.
The new bridge closes that missing boundary, not Linux/ISA/release closure.

## One executable owner and a derived comparison witness

The independent compiler appends `machine.image` to the ordinary Wasm it
already emits. The executable prefix is unchanged. The non-executable custom
section carries ABI versions, the accepted canonical ELF digest, maximal
coordinate ranges, packed 4-bit source lengths-minus-one and only each range's
necessary contiguous source witness. Ranks and witness offsets are prefix
sums, not extra saved coordinate columns. The immutable ELF digest is computed
once at compiler open, not by rehashing the entire image for every module.
Iterator open still revalidates the borrowed immutable input.

The C projection reader checks the standard section envelope, imported
immutable i64 `machine.image_bias`, final `entry` export, code/function/export
counts, ABI, maximal ranges, span/padding and the exact necessary witness end.
It does not decode/execute guest opcodes, check compiler equivalence, or replace
the Wasm engine's function-type validator. Wasm remains a derived backend
projection, not a new canonical executable or proof format.

The existing C authenticated directory first selects the exact (0,0)
IMAGE_SOURCE row. `vm_directory_image_source_bind` retains that row's digest;
the VM need not fetch/readAll the source ELF merely to learn its identity.
The IMAGE_MODULE object is authenticated normally. Its metadata must match
the source digest and authenticated interval. C checks the pending current
CPU RIP, generation, lease, exact source bytes and admitted one-instruction
budget, then produces a 24-byte prefix/bias/count DTO. The supervisor consumes
that prefix and installs its ordinary typed `entry`; C publishes the selected
span. It never accepts a host-selected source span or scalar binding.

A crossing witness returns TAIL until the existing C MMU admits the next
executable page. A failed `vm_directory_image_select` restores the prior
coordinate, so TAIL requires extend THEN repeat selection, not a new fetch.
Stale or mismatched source is a refusal, never a synthetic guest fault.

The caller pins the verified private buffer until cancellation/query/rebind.
Explicit `vm_directory_image_select` reuses that object/ticket after C checks
the current source. Under the SAME generation, pinned object and immutable
load bias, the supervisor may retain its already constructed instance; it
must not hash/compare the entire Wasm again for every source coordinate.
Changing the object/import owner/bias requires a new engine admission.
Engine/table identity and buffer pinning remain trusted-supervisor obligations.
Root authentication is not release authorization: a signed compiler/CPU/load
contract is still required before a production Linux root can be accepted.

## Actual execution and refusals

Receipt. The genuine normally linked,
postlinked and independently verified 384-coordinate ELF still has one
10,224-byte canonical owner. Its 2 modules now total 40,598 bytes. Index/root
included, the directory is 51,246 bytes, **771 more** than the prior delivery
fixture because it now carries the missing admission witness. This is not a
distribution size reduction or a minimal storage claim.

The actual C VM keeps its unchanged 64-row source owner alive while visiting
all 384 coordinates at three biases, including the high-half kernel region.
1,152 CPU/segment/port/RAM comparisons match the current standalone cold C
emitter, with zero compiler calls during execution and 6 code constructions.
This is same-compiler/C-MMU parity, not independent native ISA proof.

An actual second ELF linked with text at `0x401ffd` crosses a physical fetch
page. Its six final coordinates give 18 more comparisons, 6 C-admitted tails
and 3 constructions. The two inputs give 28 unchanged refusal controls,
including missing source identity, stale generation/ticket, source mismatch,
missing/tampered tail, out-of-interval or cancelled selection, private-buffer
alias and stale publication. Failed selection preserves the previous plan.

The prior per-coordinate reload driver needed 2,307 node reads / 1,154 object
reads. Explicit pinned selection reduces the corresponding multi-module
sequence to 12 / 8. Hot engine witness lookups are 6, not 1,152. These counts
include the driver's refusal setup; they are not Linux fetch/time measurements.

The SAME shared test runs in Node and the real in-app browser Worker. The
actual browser displayed pass, secure context true, isolation false, both
inputs' exact counters and `linuxBoot: not-tested`. The Worker is terminated
after reporting. Native compiler/VM regressions and scoped ASan/UBSan pass,
including every 2,129 / 2,890 byte truncation and malformed/nonminimal image
descriptors. Existing source admission (512 cold + 512 hot CPU comparisons)
and the 130-row source-module path (780 native/C-MMU comparisons + 3 crossing
cases) remain green; the new image role does not bypass them.

```text
node data/oracle/check-image-admission.mjs VM.wasm COLD.wasm VERIFIED.elf DIRECTORY
node data/oracle/prepare-browser-image-admission.mjs VM.wasm COLD.wasm MULTI.elf DIRECTORY CROSS.elf CROSS-DIRECTORY
http://127.0.0.1:8080/src/v2/vm/check/browser/image-admission.html
make -C src/v2/wasm-compiler check
make -C src/v2/vm check
LENGTH3_IMAGE_INPUT=SMALL.elf LENGTH3_STREAM_INPUT=MULTI.elf make -C src/v2/wasm-compiler segment-sanitizer-check
```

The fixtures are generated under the existing ignored browser `generated/`
directory; its local SHA-256 manifest is a stale-fixture check, not a signed
release. Standard ELF reading in this diagnostic only seeds test RAM. Product
execution/source selection stays in C; no host canonical-row/ISA interpreter
is introduced. Native publication and the human UI are unchanged.

## Still red

The same published make still has 7,183 genuine backend misses, first `dfe8`
at `0xa0c9`. Whole-directory preparation must refuse it before publication.
No partial observed-domain root replaces full closure. Raw-page startup is
not migrated by this small-image pass. Complete actual ISA/source-context and
executable-generation closure, authenticated bounded image residency, exact
machine/device/dirty-cut recovery, and offline development/granted-network
acceptance remain open. The prior long Linux browser run crashed without a
shell; its cause/RSS and the cold-shell three-second target remain unproved.
