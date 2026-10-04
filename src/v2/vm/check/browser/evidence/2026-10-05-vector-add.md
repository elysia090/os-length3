# Actual MOVD progress and next packed-add frontier — 2026-10-05

The [completed, unmodified independent Node receipt](2026-10-05-node-startup-paddq-red.json)
uses the same published kernel, root image, hidden-segment witness and final
63,052-byte VM with the 440,884-byte scalar-transfer compiler. It crosses
MOVD and the next register MOVDQA transfers, ending at common grammar -102:

```asm
ffffffff81204dda: 66 45 0f d4 f7     paddq %xmm15, %xmm14
```

157,428,081 retirements / 84,241,394 admissions and 7,041 console bytes reach
NETLINK initialization, not PID 1, release-root mount or shell. Counts and
calibration vary between runs; their decrease is not a speedup. Complete
14,622,864-byte decompression remains independently identical. This receipt
does not use the later PADDQ compiler or observe a retained browser Worker.
Raw SHA-256:
`512ddef7fbdda0eab3e1da48bd1f96c5b9334375a14531a53847af3263f93d4a`.

At refusal, CR0=0x80050033, CR4=0x6b0, EFER=0xd01, MXCSR=0x1f80;
XMM14 low/high=0x240/0 and XMM15=0x40/0. These are readonly observations,
not patched state or a checkpoint used to skip boot. Linux handles unsupported
microcode MSR accesses itself; complete CPU/device compatibility remains open.

Engine construction dominates: 12,708,506 constructions, 12,707,761 quota
evictions, 2,451,891 hits, 744 retained entries / 262,008 bytes. One
construction follows changed bytes; the rest follow absent exact keys.
Milliseconds: cold C 127,532.9, engine 308,465.5, execution 77,394.3,
admission 20,503.9, supply 178.1, elapsed 668,262.0. These are diagnostic
phases, not isolated cold-shell benchmarks. Three-second shell remains unmet;
module/topology reuse is not minimized.

## Red first, one generic operand boundary

Static inspection of the authenticated decompressed ELF identified the nearby
add while startup was running. The [pre-lowering red](2026-10-05-vector-add-red.log)
records 5,120 actual native observations and compiler -102 at new form 32.
All preceding 4,096 records remain byte-identical. Eight added PADDQ forms
cover register transfer, alias and six memory address topologies. Memory
keeps legacy 16-byte alignment and precise SSE control/fault ordering.

The Intel [SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B 4-201..4-207 and Vol. 2A type-4 exceptions specify wraparound with no
arithmetic flags. Substitution gives two independent pure lanes:

```text
old destination = (a0,a1); captured source = (b0,b1)
new destination = ((a0+b0) mod 2^64, (a1+b1) mod 2^64)
```

Each output is one Wasm i64 addition after input loads. Both sources/results
remain local until operand preflight succeeds; aliasing doubles old lanes,
not newly published words. There is no SIMD output image, memory-array loop,
separate interpreter or mnemonic-specific VM operation. The existing generic
vector read/pair boundary and shared SSE guard are reused. This is not a
minimum native-x86 work proof: native PADDQ is one SIMD instruction; global
topology/work/span optimization remains separate work.

[Full receipt](2026-10-05-vector-add-comparisons.json): 40 exact native/cold
emissions, 5,120 unchanged pre-lowering records, 5,120 direct and 5,120
C-dispatched complete CPU/RAM comparisons, 10,240 RF checks, 7,232 native
fault comparisons, 560 control models, 116 wait/retries, 544 entry refusals,
16 register aliases and 14 pair-boundary refusals pass. Native frames are from
the WHPX build VM; privileged controls are models, not a physical-system
oracle. Unrelated GPR/XMM/x87/MXCSR/RAM remain unchanged. Other packed and
floating-point arithmetic are not accepted by this addition.

Final full compiler checks and scoped ASan/UBSan pass. All 108 MOVD/MOVQ and
16 MXCSR emissions remain byte-identical and complete regressions pass;
31 default startup observations remain unchanged. Added lowering is 242
compiler bytes (440,884 -> 441,126); VM is unchanged. Final compiler SHA-256:
`361929429b55b73a24bb2cfa3dbbda9a7a26247f51d5df1870e1b43da8d9f38f`.
The exact shipped PADDQ/MOVDQU gates compile in the fixture; PADDQ during full
Linux startup still needs the next run. No native distribution, human UI or
retained browser Worker changes. Browser URL policy, strict native CALL and
Windows RTC oracle reds remain open.
