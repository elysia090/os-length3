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
