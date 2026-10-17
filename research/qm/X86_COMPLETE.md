# Quotient Minimizer: x86-64 frontend completeness boundary

## What “complete” means here

QM optimizes deterministic application-level functions.  For that domain, x86-64
instruction coverage is no longer defined by the handwritten Python interpreter.
The interpreter is only a fast path.

The completeness path is:

```
assembly / relocatable object
        ↓
link with typed ABI harness
        ↓
native x86-64 CPU or external execution runner
        ↓
finite concrete semantics
        ↓
Stage 1 quotient
        ↓
Stage 2 synthesis
```

Therefore an instruction does not need a Python `elif opcode == ...` case to be
usable as an input semantic primitive.  If the selected execution backend can
execute the instruction, QM can sample/exhaust its function semantics.

## Inputs

- `.s` / `.S`: assembled by clang/gcc. Intel or AT&T syntax is accepted according
  to the assembler used by the file.
- `.o`: linked directly.  This bypasses the local assembler's mnemonic vocabulary,
  which is useful when the object was produced by a newer compiler/encoder.
- SysV x86-64 ABI.
- Microsoft x64 ABI through clang's `ms_abi` bridge.

## ABI atoms

Values:

```
u8 u16 u32 u64 u128
i8 i16 i32 i64 i128
f16 f32 f64 f80
v128 v256 v512
```

`f80` uses the exact 10-byte x87 extended payload on the wire, excluding C
`long double` padding.

Pointer buffers:

```
in:N
out:N
inout:N
```

where `N` is the byte count.  Mutated `out`/`inout` buffers are part of the
observable result.

## Backends

### Python interpreter

Fast/inspectable path for common compiler-generated integer/BMI/SSE/AVX2 code.
It is useful for path inspection and synthetic addresses but is deliberately
not the coverage boundary.

### Native execution oracle

The original x86 function is linked into a small binary-protocol helper.  The
helper is persistent, so a finite domain such as all 256 masks does not pay a
process startup per input.

On direct native execution:

- strict seccomp is entered after dynamic startup;
- resource limits and a parent timeout are applied;
- target memory is isolated in the helper process;
- unknown/unsupported CPU instructions fail as an oracle error rather than
  corrupting the QM process.

### External runner

`runner_prefix` can place an emulator in front of the helper.  For Intel SDE:

```python
runner_prefix = sde_future_prefix('/path/to/sde64')
```

which expands to:

```
sde64 -future -- qm_oracle
```

Strict seccomp is automatically disabled for an external runner because the
emulator itself needs system calls.

## Default purity boundary

QM's default specification is a deterministic pure function.  The oracle
therefore rejects known classes of machine/environment observations when they
are visible in disassembly, including examples such as:

```
RDRAND RDSEED RDTSC RDTSCP RDPMC
CPUID XGETBV RDPKRU RDPID RDFSBASE RDGSBASE
SYSCALL SYSENTER I/O privileged control instructions
```

This is not because they are “unsupported x86”.  It is because their meaning is
not solely a function of the declared QM inputs.

`allow_impure=True` exists for experiments, but strict native seccomp still
blocks system-call escape.  A future environment model could make selected
machine state explicit inputs/observables.

## What is intentionally outside the current QM semantic contract

The following need a richer observation/state model rather than another opcode
case:

- privileged OS/hypervisor state;
- port I/O and syscalls;
- nondeterministic RNG/time/counter instructions unless environment is explicit;
- concurrent memory-order semantics and races;
- self-modifying code;
- architectural faults/exceptions as first-class observable outputs;
- 16-bit/32-bit execution modes (the current product target is x86-64).

Single-threaded `LOCK`/atomic code can physically execute in the oracle, but QM
currently does not claim equivalence under a concurrent memory model.

## Regression coverage actually run

The complete frontend regression currently covers:

- existing scalar/BMI/SSE/AVX2 interpreter tests;
- `ranks8` asm → QM, reproducing 502 residual solutions;
- automatic fallback on `CRC32`, which is intentionally absent from the Python
  opcode switch;
- AVX-512 `VPTERNLOGD` on ZMM arguments;
- AVX-512 `VPCMPUB` + k-mask `KMOVQ`;
- AES-NI `AESENC`;
- x87 `long double` exact 80-bit payload;
- RIP-relative constant addressing plus a finite branch loop;
- Microsoft x64 ABI register assignment;
- pointer `inout` memory semantics;
- 128-bit integer return in RDX:RAX;
- relocatable `.o` input;
- default syscall purity rejection;
- strict-seccomp kill after explicit impure opt-in.

Run:

```
python3 /mnt/data/qm_e2e/test_x86_complete.py
```

Expected final line:

```
complete x86-64 frontend regression OK
```
