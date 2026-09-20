# TODO — 2026-09-20

## Goal

Run the complete fixed distribution as ordinary optimized x86-64 ELF, with
quotient normal forms and matching lower-bound proofs and executable
constructions under explicit semantics, ISA/ABI, grammar and cost models.
Preserve the independently runnable native release before deriving its browser
projection. An unproved minimum remains an open obligation.

```text
fixed recipe → build/link → independent C post-link compiler
→ ordinary optimized x86 ELF → verified and signed packages
→ authenticated release → native validation → browser projection
```

## Evidence policy

This is the 09/20 plan, not a progress history. No historical completion marks,
test results, blocker coordinates, counts or size estimates are inherited.
All items start unchecked; this does not imply the implementation is absent.
Record results only with the actual input identities, dirty source state,
tool versions and command. Replace superseded facts in place.

## 1. Establish the current baseline

- [ ] Inspect recent commits, uncommitted changes and applicable design
  contracts before editing implementation.
- [ ] Identify the fixed distribution recipe, locked upstream inputs, full
  package closure and reusable checkpoints; reconcile them with actual files.
- [ ] Identify active builds and their inputs before replacing outputs.
  Keep temporary work on Windows; do not use NixOS.
- [ ] Rebuild and run applicable checks, native differential tests and
  sanitizers. Separate failures from unsupported cases and skips.
- [ ] Compile the kernel and complete linked ELF population. Rank blockers
  from these current runs rather than old logs.

## 2. Close and prove the general post-link path

- [ ] Reproduce each blocking family as a failing general regression, then
  fix the common implementation.
- [ ] Preserve values, defined flags, faults, memory effects, control flow,
  relocation bindings and publication lifetimes through SSA normalization,
  instruction selection, scheduling and final ELF emission.
- [ ] Differentially execute every generated alternative. Do not hide valid
  alternatives or weaken assertions merely to pass a gate.
- [ ] Derive work and span lower bounds independently and construct a candidate
  attaining both. Otherwise retain the Pareto frontier as unresolved.
- [ ] Distinguish candidate-family minima from grammar-wide proofs. Include
  cross-block sharing, observable coordinates, bindings and layout.
- [ ] Reject unresolved semantics and proof obligations at publication.
  Remove escapes through general normalization, not application-specific
  handlers, interpretation or runtime fallback.

## 3. Package the complete native distribution

- [ ] Produce and independently verify ordinary optimized ELF for every
  required component. Keep post-link compilation independent of Wasm and VM.
- [ ] Transform ELF before package creation and signing; validate ownership,
  dependency/resource closure, scripts, triggers and root authentication.
- [ ] Include kernel and boot objects, tools, libraries, headers, service and
  package databases, configuration, trust roots and dynamic dependencies.
- [ ] Keep upstream inputs in `data/`, disposable outputs in `temp/`, and
  accepted delivery objects in `artifact/`. Reuse only matching checkpoints.

## 4. Minimize storage and actual execution costs

- [ ] Inventory the complete release's retained populations and bytes.
  Starting with the largest, derive and test sharing of equivalent blocks,
  pure slice topology, instruction semantics, immutable data and archive members.
- [ ] Remove reconstructible proof state, coordinates, bindings and directories.
  Follow the Artifact/Storage contracts without a parallel materialized path.
- [ ] Establish representation bounds and measure residual population and
  linear coefficients. Faster serialization is not reduced storage.
- [ ] Compare unoptimized and optimized releases with identical recipes and
  workloads. Report storage, ELF size, transfer size, native runtime, compiler
  time and peak memory separately.
- [ ] Reduce dominant runtime work and dependency span. Verify actual speed;
  static instruction counts do not establish an elapsed-time improvement.

## 5. Validate the delivered system

- [ ] Boot the optimized native distribution; exercise shell, C compile/run,
  `make -j`, Git and granted HTTPS. Shell readiness must not require networking.
- [ ] Run x86, signal, futex, clone3, exec, timer, ptrace, IPC, mm, tty, seccomp
  and network tests without including test payloads in the release.
- [ ] Preserve the verified native release, then derive Wasm from accepted
  optimized ELF. Verify browser terminal use, authenticated lazy delivery,
  VFS recovery and memory release with Linux as semantic authority.

## Completion gate

The complete recipe, scoped minimum proofs, accepted packages and actual
distribution execution must agree. A passing fixture, build-host shell,
partial root, modeled speedup or unproved candidate minimum is not completion.
