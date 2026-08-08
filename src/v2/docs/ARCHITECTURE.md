# Architecture

## Layers

Each module imports only from lower layers, so the dependency graph is a DAG and
any layer can be read on its own.

```
0  bits                       PDEP/PEXT/CLMUL, GF(2^128), masks, probe streams
1  observer  semantics        obs : Output -> Observable; finite domains
   guards    version
2  quotient  program          the two quotients; the abstract op grammar
3  cfront/   clang  asmstats  frontends: source -> semantics
   asmfront/                  x86-64 and wasm32 readers
   frontend                   registry: clang · precompiled · cfront · asm
4  solvers   isa              Stage-2 search; ISA profiles and lowering
   recognize corpus
5  pipeline                   the whole product in one call
6  cli  browser               the two front doors
```

`pipeline.solve()` is the only thing either front door calls, so the CLI and the
browser cannot diverge in behaviour.

## The frontend boundary

A frontend produces `Semantics`: a callable on a declared finite `Domain`, plus
a report. Nothing downstream knows whether the values came from Clang, from the
built-in interpreter, or from a table computed in JavaScript.

That is what lets the browser put the expensive part where it belongs. The
worker compiles with clang.wasm, executes the wasm32 module over the domain, and
hands Python a table; `frontend.PrecompiledFrontend` wraps it and the pipeline
proceeds identically to the native path.

It is also what makes x86 → wasm and wasm → x86 ordinary uses of the pipeline
rather than separate features. `asmfront` evaluates a pasted listing the same
way the Clang path evaluates a compiled module, `frontend.AssemblyFrontend`
wraps it, and the target selector on the far end decides which machine comes
out. A listing does not record how wide its input was meant to be — `%rdi` is
64 bits whether the kernel took a byte or a word — so the emitters write a
`qm-input-bits:` line and the readers read it back; without it the width is
assumed and the report says so.

Both readers are deliberately partial: each covers the integer subset a small
kernel compiles to, and names anything else instead of guessing. A wrong
evaluation there would be a wrong semantics, and every claim downstream rests
on it.

## Decide once, not once per input

Everything QM claims rests on evaluating something over a declared domain, and
a 16-bit kernel has 65,536 points in it. Three places used to walk their own
program per input and re-decide what each instruction was: the C subset, the
lowered sequence, and the two assembly readers. The opcode does not depend on
the input, so the decision is taken once and the sweep runs a list of closures
with the constants already bound.

In each case there is one implementation and not a fast path beside a reference
one — `isa.run` and `isa.compile_seq` share their steps, as do
`asmfront.wasm.evaluate` and its compiled form — and the suite checks the two
entry points agree. A fast path that could drift from the reference would mean
the verification counts in the report describe a different program from the one
that gets emitted.

## Why the lowering is an SSA DAG

SPEC §8 ranks candidates by `(span, work, L(z), rank)` and SPEC §11 insists that
core operations, machine instructions and microarchitectural cost stay distinct.
A chain representation makes span and work the same number by construction, so
`isa.Seq` is an SSA DAG: span is the critical path, work is the instruction
count, `L(z)` is the description length of the encoded program, and `rank` is
the encoding itself, compared lexicographically.

The encoding is accumulated as bytes rather than as one big integer, because a
2^16-entry lookup table encodes to about four million bits and materialising
`1 << bits` for it costs more than the rest of the pipeline put together.

## Ranking

Candidates are lowered on a sample of the domain and ranked; only the winner is
then lowered and verified over the whole domain on every target. Fully verifying
every rejected candidate on every ISA is work whose result is discarded.

The finite-domain lookup table is ranked as a fallback rather than as a minimum.
It always verifies, which is what makes "no solution" mean "no compact
solution", but it answers a different question than SPEC §35 asks.
