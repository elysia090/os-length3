# Whole-image bounded module directory — 2026-10-07

The old single-module image path refused every image with more than 256 final
PF_X coordinates. The directory path now traverses the ENTIRE immutable final
image through the same frontend/body writer, before any module or filesystem
publication. All maps/interior/zero-fill coordinates must lower. A grammar,
fetch-context or irreducible capacity failure returns an error, never a fake
architectural fault, dropped coordinate, prefix root or interpreter fallback.

## Construction and projection

`wasm_compiler_prepare_image` measures a deterministic partition. Start with
up to 256 contiguous coordinates in one executable map; on a real final-object
or body-definition capacity refusal halve the interval and retry. A one-entry
refusal aborts the whole plan. Different maps never get a gap-spanning interval.
No per-coordinate plan, output code population or descriptor directory is
retained. The receipt has aggregate counts, exact source identity and maximum
actual module size. It is a construction receipt, not an authorization proof.

`wasm_image_iterator_open` checks the compiler/input lifetime and source digest.
`next` reuses ONE caller-owned buffer and returns original ELF interval bounds
plus the ordinary module report. Full completion must match planned modules,
coordinates and bytes. Short capacity / alias / failed source identity controls
preserve outputs and cursor. Input/plan/compiler are immutable for construction.
The cold C exports have one protected plan/cursor; failed prepare or close
revokes the previous iteration. They carry no executable operation stream.

The CLI `--directory INPUT.elf NEW-DIRECTORY` is a publication adapter. Only
that adapter knows Artifact or files; the compiler library/cold Wasm does not.
It uses existing Artifact resource rows, node writers/readers and SHA-256.
The native ELF is the canonical source owner; Wasm modules are derived backend
delivery/cache projections, NOT another canonical residual machine. Current
output keeps that ELF once, rather than once per module.

```text
root-ref  (existing 88-byte index reference; namespace publication last)
  key (0,0): IMAGE_SOURCE -> one ordinary canonical optimized ELF
  key (1,first): IMAGE_MODULE -> ordinary Wasm entry object
                  coordinate = exclusive original ELF interval end
```

Objects/nodes use their existing content-addressed filenames. Module imports,
immutable `machine.image_bias`, entry ABI and typed C callbacks are unchanged.
No custom instruction package, guest syscall implementation or JS row reader
is introduced. Stored Wasm bytes are not a new identity or global semantic /
work/span minimum. Module-to-module body sharing is not proved here.

## Index frontier and readiness boundary

The previous batch index writer needs the entire row population and a leaf
reference frontier. The streaming extension uses the SAME canonical leaf /
branch serializers and authenticated references. It holds the unfinished leaf
and at most one unfinished reference group per level. Finish lifts a lone low
child only when higher groups exist, matching the batch writer's partial-group
normal form. Root/node bytes match exactly at 11 leaf/branch boundaries, including
unary partial groups. Duplicate rows, publication failure and repeated finish
are checked. Current bounded allocation is 71,760 bytes (maximum levels), not
a measured minimal per-case allocation or runtime RSS bound.

The existing C directory owner (unchanged 304 bytes) uses authenticated floor
lookup for IMAGE_MODULE, then enforces same major and first <= key < end.
Holes and the final exclusive end refuse. Other roles retain exact lookup.
300 interval lookups / 100 holes and existing 3,000 exact paths pass, including
stale/corrupt/cancel/reopen/exhaustion and ASan/UBSan controls.

READY only authorizes the verified immutable byte witness. The distinct image
role cannot use the old `machine.source` selected-cut execution admission.
The image source/span/bias/generation execution connection is still missing;
the new root must NOT be substituted into the browser's fresh-cut run and
declared complete. Root hashing is not release authorization. `root-ref` is
written to a fresh temporary file then renamed last; existing directories are
refused without modifying prior bytes. This is namespace publication, NOT a
fsync/durable recovery guarantee. I/O failure may leave unreferenced staging.

## Exact scope and measured blocker

Receipt. Actual ordinary linking ->
postlink -> verify produces a 10,224-byte ELF with 384 final executable byte
coordinates. Its initial full backend inventory was 383/384: `0f0000` SLDT
memory was genuinely unlowered. It is not omitted from the new root.

The shared selector descriptor law now covers ES..TR snapshots. SLDT/STR use
the visible 16-bit LDTR/TR selector; memory stores exactly two bytes and wider
GPR forms use the existing publication width rule. UMIP + CPL>0 produces a
pending #GP before destination access, without retirement/CPU mutation. No new
VM operation callback is added. These conditions follow Intel's
[instruction reference, SLDT/STR sections](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf).
288 descriptor/C-MMU models with 216 faults cover prefixes, FS/GS, address32,
readonly/absent RAM and atomic cross-page stores. They are NOT a native hardware
UMIP/selector proof. Host Linux may emulate these user-mode instructions;
do not treat that as a ring0 native observation.

The complete example now gives 2 modules / 39,827 Wasm bytes and a 3-row existing
index. Source + modules + index + root-ref is 50,475 bytes. Seven actual C-Wasm
index/object queries match native/cold module bytes with 15 stale/corrupt/end
refusals. No host root/row or guest ISA parser is used. This is NOT a Linux
distribution-size reduction: the input program fixture is small.

Actual published make has 233,455 final coordinates, 226,272 lowerable and
7,183 missing (6,955 valid + 228 fault forms), first `dfe8` at `0xa0c9`.
The new --directory refuses -102 before creating a directory/root. The former
global -104 restriction is no longer what hides this genuine grammar deficit.
Full compiler/VM regressions, existing source-module / small-image parity and
scoped address/undefined sanitizers pass. One old unsigned-bit promotion
warning in factor-codec was fixed without changing byte spelling.

Native publication and human UI are unchanged. No new signed Linux projection,
real-browser boot, shell, cold-ready/RSS measurement or storage/network service
acceptance is claimed. Remaining work is full actual ISA / source-context
closure, C image execution admission/residency, exact machine/dirty/device
recovery, then the original offline development and granted-network browser
requirements. Producer/delivery green is not goal completion.

```text
wasm-compiler --directory VERIFIED.elf NEW-DIRECTORY
make -C src/v2/wasm-compiler image-stream-check
make -C src/v2/artifact index-stream-check
make -C src/v2/vm directory-check directory-sanitizer-check
LENGTH3_STREAM_INPUT=VERIFIED.elf make -C src/v2/wasm-compiler segment-sanitizer-check
node data/oracle/check-image-directory.mjs VM.wasm COLD.wasm VERIFIED.elf NEW-DIRECTORY
node data/oracle/check-selector-snapshot.mjs VM.wasm COLD.wasm
```
