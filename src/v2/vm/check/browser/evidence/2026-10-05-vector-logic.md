# Precise vector logic through the common compiler — 2026-10-05

The two completed independent startups both reach the actual shipped PXOR
memory gate at `0xffffffff81204dec`; the later run uses the new borrowed
source layout and has no copied-input fallback. Neither reaches PID 1 or
shell. See [receipts and measured construction cost](2026-10-05-compiler-borrow.md).

## Red, derivation, general boundary

[Before lowering](2026-10-05-vector-logic-red.log), the independent native
fixture captures 17,408 full CPU/RAM observations / 7,568 fault frames; the
old compiler rejects new form 40 with -102. Twelve logical families add 96
forms to the unchanged 40 transfer/PADDQ forms: PXOR/PAND/POR/PANDN,
XORPS/ANDPS/ORPS/ANDNPS and their PD counterparts. Each family has separate
registers, self-alias and six ordinary memory address topologies, using high
XMM registers. The original 5,120 records, 40 source pages and 40 native
emissions remain byte-identical to the preceding checkpoint.

Intel [SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B PAND/PANDN/POR/PXOR, Vol. 2A logical PS/PD and type-4 exceptions,
and Vol. 2D XORPS/XORPD define raw bitwise operations with no numeric
exceptions. The common two-word substitution is:

```text
old destination A=(a0,a1), captured source B=(b0,b1)
XOR:     (a0^b0, a1^b1)
AND:     (a0&b0, a1&b1)
OR:      (a0|b0, a1|b1)
AND-NOT: (~a0&b0, ~a1&b1)
```

Packed, PS and PD encodings converge to these same normalized operations;
PANDN's existing packed descriptor converges to the same AND-NOT lowering.
There is no host floating-point instruction, output record, lane array or
mnemonic-specific VM callback. Both input/result words remain locals until
the precise operand frontier succeeds. General distinct operands use two
independent Wasm i64 logical operations (AND-NOT adds a complement per word).
Native x86 uses one SIMD instruction; this is not a global native minimum
work/span proof.

Self-alias is normalized further **after** the common SSE control guard:
`A^A=0`, `~A&A=0`, `A&A=A`, `A|A=A`. Zero forms store a constant without
reading the XMM payload; identity forms have no XMM payload read or write.
Neither substitutes away #UD/#NM, source admission, RIP or retirement.
Memory forms still preflight all sixteen bytes with legacy alignment and
precise fault/wait priority, even when data could produce a constant. No
data-dependent guess can skip the operand frontier.

## Verification and remaining gates

[Comparisons](2026-10-05-vector-logic-comparisons.json): 136 exact native/cold
emissions, 17,408 unchanged pre-lowering observations, 17,408 direct and
17,408 C-dispatch full CPU/RAM comparisons, 34,816 RF checks, 30,272 native
fault comparisons, 1,904 control models, 356 wait/retries, 1,840 entry
refusals, 64 register aliases and 14 pair-boundary refusals pass. Fixtures
preserve unrelated GPR/XMM/x87/MXCSR and code/RAM. Native user observations
are from the independent WHPX build VM; privileged controls remain explicit
models, not a full physical-system oracle.

Full native compiler checks/CLI and scoped compiler ASan/UBSan pass. All
108 scalar-vector and 16 MXCSR native/cold emissions and full comparisons
remain byte-identical; borrowed-input and output-growth tests pass. The
same one-million-admission startup retains all architectural/source/trace
and resident observations: 1,616,430 retirements, 620,243 emitted bytes,
7,262,208 borrowed bytes, zero copied bytes. Only compiler size, explicit
UTC/clock sampling and diagnostic times change from the borrowed checkpoint.

The compiler is 442,311 bytes, +433 over the 441,878-byte borrowed compiler;
SHA-256 `8c60d2223a9c29e99fdc78d1ac6b199f5a79b52763bbcbcb97dd70ca4c0767ea`.
The VM and native distribution are unchanged. Exact shipped PXOR emits in
the fixture. An independent extended same-bundle run is now in progress on
this final compiler; this document does not claim the fixture executed that
Linux instruction. Browser policy prevents a current real-browser acceptance
check and no workaround is used. PID 1, release-root mount, shell/development
tools, authenticated storage/recovery and granted network remain open.
Three-second cold shell, region/topology closure and engine churn remain
unresolved. The strict native CALL and Windows RTC oracle reds are not
cancelled by the unrelated green compiler check.
