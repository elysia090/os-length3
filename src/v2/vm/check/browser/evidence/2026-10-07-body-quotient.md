# Exact emitted body quotient — 2026-10-07

The previous source-module fixture had 130 exported source coordinates AND
130 copies of one identical MOV32 function body. Independent standard-Wasm
structure check is red: function/code counts 130, required one. Scalar binding
and source identity are already outside that executable transfer.

The module writer now forms the exact byte-body quotient under its ONE shared
typed-import mapping. A bounded merge sort orders rank descriptors by length
and complete bytes; equality is checked in full, without hash authority or
pairwise all-to-all scans. Every source export survives and directly aliases
its class representative. No forwarding wrapper or opcode stream is added.
All functions have the same machine-entry type and contain typed IMPORT calls,
not module-local function calls requiring index rewriting. Source rows retain
their own span/count/budget/binding. The C reader checks source export count
separately from unique function/code count.

Ranks are deterministic in sorted source-entry order: the first member emits
the shared representative. This is a backend byte identity, NOT a proof that
different emitted bodies cannot have equal complete futures or smaller work/span.

[Receipt](2026-10-07-body-quotient-green.json): 130 exports -> one body,
30,614 -> 7,646 bytes (derived source witness/metadata included). Four same-length
but different destination bodies remain four classes (8,180 bytes). The separate
three-export crossing collection shrinks 8,898 -> 8,542 bytes. Native/cold bytes,
780 complete CPU comparisons, unchanged 64-row source-owner eviction/reuse and
three crossing/two-page cases pass. The mixed 28-cut/native compiler checks,
full VM/compiler checks and scoped ASan/UBSan pass. Source/cohort, pending faults
and 750 native selector comparisons remain green.

```text
make -C src/v2/wasm-compiler source-module-check
make -C src/v2/wasm-compiler segment-sanitizer-check
node data/oracle/check-body-quotient.mjs projection.wasm 1
node data/oracle/check-body-quotient.mjs mixed.wasm 4
```

Current construction conservatively preflights the UNQUOTIENTED collection
against the existing cap, then compacts the SAME output owner. Rank arrays are
bounded by 256; no second encoded-module/body buffer is allocated. It re-emits
unique representatives from pinned original input and shifts inert metadata
forward; unreachable old bytes are zeroed. This is NOT the final fully virtual
Byte* writer: temporarily formed raw bodies and the conservative raw-size
admission still remain. An otherwise fitting quotient can therefore still be
refused if its raw population exceeds the cap. Do not hide that limitation by
raising quotas or call this minimum compile work/materialization.

```text
compiler.wasm 461,441 bytes
8b57c2deaea207b4c4196acc904863cb1f3c2091519d12634589952a98d6c016
vm.wasm 87,193 bytes
7b5bf95bd368411a7eb030020d6873ce9cafb76c467a2dfb96723c49dae482fd
```

Same-bundle short Node prefix retains the complete 86-instruction witness and
1,617,931 retirements, then quota. It does not use a completed Linux projection.
No new real-browser run or renderer-crash fix, distribution size reduction,
RSS bound or Linux speedup is claimed. Whole accepted ELF/control/indirect
production remains -104. Complete production, virtual identity/rank writer,
authenticated source residency and exact Worker/machine/dirty/device recovery
still lead to the full offline development/storage/network browser gates.
Native release/human UI are unchanged; cold shell three seconds remains red.
