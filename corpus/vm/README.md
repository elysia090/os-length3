# VM physical forms

VM experiments in this category consume ordinary canonical images. They may
change the in-memory layout, but never add layout tags or operations to the
artifact.

The current reusable building block is
`../physical-array/pa_grouped_spans.h`: it converts row source/destination
coordinates to two contiguous incidence spans. One transition then reads its
resident `old` and `change` values and updates each affected span as a regular
array wave.

Keep the scalar transactional VM as the oracle. A physical form becomes a
runtime backend only after feed commit, speculative read rollback, input-cell
updates, and self-modifying code agree with that oracle.

`stream_accumulator.c` is the small whole-program frontend case. Its packed
`accumulator_step` is a scalar QM input, while its `main` keeps state across
imported input calls. Compiling the complete unit to linked wasm therefore
checks both boundaries without giving C a second execution model.

The poll and console entries isolate three common machine-loop costs: an
invariant device observation across a retry budget, dead arithmetic inside a
delay leaf, and line-sized output publication.  They use packed scalar inputs
so both machine frontends can measure the same total function without a host
device API.

`affine_compose8.c` is a deterministic fuzzer reduction.  It keeps the exact
constants that exposed the gap: three source operations have one two-operation
modular affine normal form and must never become a materialized lookup table.

`xor_residual8.c` is the Wasm stack-recovery reduction: a zero-minus-value is
`NEG`, and its five source operations normalize to four instead of a table.
`signed_projection_cut8.c` is the remaining cross-frontend pressure case.  C
optimization exposes a three-operation signed projection while a raw listing
still needs the common semantic solver to recover the same closed form.
`gf2_affine_cut8.c` fixes the other general entrance: nonzero `f(0)` is removed
before deriving the GF(2) basis, and the declared 8-bit input width removes a
redundant mask during lowering.
