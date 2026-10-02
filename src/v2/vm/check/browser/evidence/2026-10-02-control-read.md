# Common control-read checkpoint — 2026-10-02

This extends the [26-instruction checkpoint](2026-10-02-rmw-control.md), without
replacing its observed JSON/builds. The same shipped bzImage now retires
**28 instructions** in the actual in-app browser's ordinary dedicated Worker:
CR4 read and the following AND are executed, not skipped. All CPU/cache bytes
are still compared. The next uncompiled coordinate is **`0x1000255`, CR4 write**.
Linux boot, PID 1 and terminal remain **not achieved**.

The compiler lowers long-mode MOV from CR0/CR2/CR3/CR4/CR8 directly to bounded
Wasm state-field loads, with a precise CPL0/#GP(0) boundary. Each source/destination
combination is its own compiled fixture, not a VM opcode dispatch. Arithmetic
flags are architecturally undefined; preserving their previous values is the
chosen representative, not an exact hardware flag result. TF/RF/VM contexts
remain explicitly outside the admitted baseline. Serialization is provided by
the single-vCPU cut boundary, not a speculative concurrent CPU.

The previous receipt's `nextGate: MOV CR4,RAX` at `0x100024d` described the read
with AT&T-style source/destination order. In Intel order that instruction is
`MOV RAX,CR4`; `MOV CR4,RAX` at `0x1000255` is the actual write. Historical JSON
is preserved exactly as observed; source coordinates and direction are explicit
here. No instruction semantics were inferred from that display string.

Exact builds:

* VM unchanged: 15,329 bytes, SHA-256
  `c05f4a97d4292a7d3cc7e6263491cd066b4d3bebe430d1d6af5d9f27d98e3cb9`.
* Cold C-Wasm compiler: 404,071 bytes, SHA-256
  `c445cfbc702bb7c0ec711fa1fca0bceaadef94e6d5aa78c7f9a59274af0108cb`.
* Native bundle unchanged:
  `4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.

`2026-10-02-startup-control-read.json` records the actual browser observation:
25 cut rows, seven recompiled admissions, 524,288 VM memory bytes and 1,048,576
cold memory bytes, secure context and no isolation. Fixture sizes are not Linux
RAM/RSS measurements. Local diagnostic SHA-256 verification is not production
root/code attestation. No JS decoder, guest-memory callback or instruction loop
is used; the existing C dispatcher drives generated functions.

Checks:

* 80 generated modules: five control sources × sixteen GPR destinations.
* 5,360 independent privilege/value/TF/RF/VM model cases, comparing all CPU
  bytes and nonretirement on failure. These test transfer/privilege lowering,
  not legality of every fabricated input CPU context or hardware exception entry.
* All 80 control writes remain compile-rejected, rather than incorrectly
  applying read semantics or bypassing CR legality/context invalidation.
* Native C / cold C-Wasm: 247 byte-identical emissions including repeat/growth
  checks over existing fixture families, shipped prefixes and control reads.
* Full `make -C src/v2 -k -j2 check` and compiler ASan/UBSan pass without
  warnings; the prior VM/RMW checks and exact VM bytes remain unchanged.
* Regenerating witnesses from the authenticated bundle produces the same
  28-instruction full-state result. Existing output directories are refused.

Reproduce using the updated `prepare-startup-cuts.sh` and browser commands in
the prior checkpoint. For the model matrix:

```sh
mkdir temp/new-control-read
src/v2/wasm-compiler/build/code-cut-check temp/new-control-read
node data/oracle/check-control-read.mjs temp/new-control-read
```

Next: common control-write legality under the fixed CPU profile, translation
and executable-context invalidation, then the remaining real decompressor
operations/exception/device/root boundaries. Do not special-case this kernel's
unchanged CR4 value as a general implementation.

Reference: [Intel SDM Volume 2B, MOV to/from control registers](https://cdrdv2-public.intel.com/868141/253667-089-sdm-vol-2b.pdf),
pages 4-32 through 4-34. Unsupported mode/exception transitions remain red.
