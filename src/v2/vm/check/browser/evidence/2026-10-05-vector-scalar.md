# Scalar-to-XMM transfers — 2026-10-05

The preceding same-bundle independent startup stopped at
`66 44 0f 6e f9` / `movd %ecx,%xmm15`, 0xffffffff81204dc2.
The [initial native observation/red log](2026-10-05-vector-scalar-red.log)
records 6,912 actual x86 CPU/RAM observations followed by the old common
compiler's grammar -102. Lowering was not tested by the observe-only phase.
The subsequent fixture refinement places 4/8-byte operands across the page
boundary rather than ending exactly on it; its fresh independent observe-only
and emitted observations agree. These refined records were not all captured
before the first lowering implementation, and are not described as such.

Legacy SSE2 MOVD/MOVQ now use the existing GPR SSA and scalar C-MMU boundary.
The compiler accepts the existing decoder's exact normalized transfer
descriptor, not a mnemonic callback in the VM. MMX, MOVQ2DQ/DQ2Q, VEX, LOCK,
FS/GS and vector arithmetic remain explicitly unsupported by this addition.

The [Intel SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B 4-54..4-57 and MOVQ, plus Vol. 2A Table 2-22 (type 5), gives the
semantics and exception contract. Let s be the captured scalar, w=32 or 64:

```text
to XMM:  low = s & (2^w-1); high = 0
to GPR:  parent = s & (2^w-1)
to RAM:  precisely w/8 bytes of s
XMM MOVQ: capture source low; destination low = source low; high = 0
```

There is no floating-point arithmetic, flag computation, 16-byte operand
image or intermediate SIMD record. Aliased XMM MOVQ captures the input before
zeroing the high lane. A 32-bit GPR write defines the whole 64-bit parent.
Memory addressing observes old GPRs; one precise 4/8-byte C access obtains
all bytes before publication. CR0.EM/!CR4.OSFXSR (#UD) precedes CR0.TS (#NM),
which precedes operand access, including register-only forms. Retirement and
ordinary RF clearing occur only after success. MXCSR, x87 and unrelated
registers/payload remain unchanged. AC/TF contexts still refuse explicitly;
this change does not claim #AC/debug execution support.

[Complete comparison receipt](2026-10-05-vector-scalar-comparisons.json):

* 108 native/cold byte-identical modules, 6,912 independent observe-only records.
* 6,912 direct and 6,912 C-dispatched complete CPU/RAM comparisons; 13,824 RF checks.
* 1,968 independent native fault comparisons, 1,512 CR0/CR4 models,
  120 wait/retries and 1,368 entry refusals.
* All sixteen GPRs and XMM bindings, both widths/directions, six address
  topologies, both MOVQ memory encodings and 512 XMM-only/alias observations.

Native fault frames are from the independent WHPX build VM, not a physical
CPU guarantee; privileged CR0/CR4 cases are separate models. The refined
native fixture observes 492 faults, including read-only, absent second page,
non-canonical/stack and whole-memory checks. No partial CPU/payload write is
accepted. Complete comparison retains actual GPR output, including RSP,
rather than assuming every transfer leaves GPRs unchanged.

Full common compiler `make check` and scoped compiler ASan/UBSan pass.
All 32 legacy 128-bit transfer and 16 MXCSR emissions remain byte-identical
and their full native/C-Wasm regressions pass. The default one-million-
admission startup retains 31 non-size architectural/source/trace/resource
observations. Added compiler code grows 439,606 -> 440,884 bytes; VM is
unchanged at 63,052 bytes. Compiler SHA-256:
`892ba7a2ba8e5905e0a1700d5c748792044dabf4b9770cc3e4648e15e3ce6b88`.
No size or boot-speed improvement is claimed from adding ISA coverage.

The exact shipped gate compiles in the fixture, but that alone is not actual
Linux execution. Extended independent startup with the same kernel, hidden
segment witness and root image completed and actually crosses MOVD, then
refuses PADDQ. See [the next frontier](2026-10-05-vector-add.md).
No PID 1/root mount/shell/browser success is established here.
The diagnostic now records CR0/CR4/EFER/MXCSR
and XMM at a compilation refusal only. The first new diagnostic was canceled
before completion to correct two observational field offsets; guest lowering
and VM semantics were unchanged. Neither retained browser Worker was touched.
The strict CALL oracle and Windows year-9999 libc reds remain open.
